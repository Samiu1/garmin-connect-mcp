/**
 * Personal API key resolution and bearer-token management.
 *
 * Garmin's Personal API does not accept the API key on data requests. The key is
 * exchanged for a short-lived JWT at the token endpoint, and that JWT is sent as
 * `Authorization: Bearer <jwt>`. Tokens last 24 hours and cannot be refreshed, so
 * a new one is obtained when the cached token is close to expiring.
 *
 * The on-disk cache deliberately matches the location and JSON shape used by
 * Garmin's official Python client, so both can share one cached token.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  API_KEY_COMMAND_ENV_VAR,
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  DEFAULT_API_KEY_FILE,
  DEFAULT_BASE_URL,
  DEFAULT_TOKEN_CACHE_FILE,
  KEY_COMMAND_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  TOKEN_PATH,
  TOKEN_REFRESH_WINDOW_MS,
} from "./constants.js";
import { GarminApiError, GarminConfigError } from "./errors.js";

interface CachedToken {
  accessToken: string;
  /** Expiry in milliseconds since the epoch, from the JWT `exp` claim. */
  expiresAt: number;
}

/** The API host, overridable for Garmin China accounts. */
export function baseUrl(): string {
  const configured = process.env[BASE_URL_ENV_VAR]?.trim();
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function keyFilePath(): string {
  return join(homedir(), DEFAULT_API_KEY_FILE);
}

function tokenCachePath(): string {
  return join(homedir(), DEFAULT_TOKEN_CACHE_FILE);
}

/** Warns, but continues, when a credential file is readable by other users. */
function warnIfWorldReadable(path: string, label: string): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(path).mode & 0o077;
    if (mode !== 0) {
      console.error(
        `Warning: ${label} ${path} is readable by other users. Run: chmod 600 ${path}`
      );
    }
  } catch {
    // Permission probing is best-effort; a missing file is handled by the caller.
  }
}

/**
 * Memoized for the process lifetime: resolveApiKey runs on every API request, and
 * shelling out each time would spawn a subprocess per request and risk repeated
 * keychain prompts. A rotated key is therefore picked up on restart, which is the
 * same behaviour as the environment variable.
 */
let keyFromCommandCache: string | undefined;

/**
 * Runs the user-configured command and takes its stdout as the key.
 *
 * The command comes from the same place as the server's own launch command, so it
 * is trusted to the same degree. stdout and stderr are both captured so neither
 * can corrupt the JSON-RPC stream on stdout, and the key is never included in an
 * error message.
 */
function keyFromCommand(command: string): string {
  if (keyFromCommandCache) return keyFromCommandCache;

  let stdout: string;
  try {
    stdout = execSync(command, {
      encoding: "utf8",
      timeout: KEY_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const detail = failure.stderr?.trim() || failure.message || "unknown error";
    throw new GarminConfigError(
      `${API_KEY_COMMAND_ENV_VAR} failed: ${detail}\n` +
        `The command was: ${command}\n` +
        "Run it yourself to check it prints the key and nothing else. On macOS, store the key first with: " +
        'security add-generic-password -a "$USER" -s garmin-personal-api -U -w'
    );
  }

  const key = stdout.trim();
  if (!key) {
    throw new GarminConfigError(
      `${API_KEY_COMMAND_ENV_VAR} produced no output. The command must print the key on stdout.`
    );
  }
  keyFromCommandCache = key;
  return key;
}

/**
 * Resolves the Personal API key, in order: the environment variable, a command
 * that prints it, then the default key file. Throws a message naming all three
 * when none supplies a key.
 */
export function resolveApiKey(): string {
  const fromEnv = process.env[API_KEY_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;

  const command = process.env[API_KEY_COMMAND_ENV_VAR]?.trim();
  if (command) return keyFromCommand(command);

  const path = keyFilePath();
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new GarminConfigError(
      "No Garmin Personal API key found. Supply it one of three ways:\n" +
        `  1. ${API_KEY_ENV_VAR} environment variable\n` +
        `  2. ${API_KEY_COMMAND_ENV_VAR} set to a command that prints the key, ` +
        'e.g. "security find-generic-password -s garmin-personal-api -w"\n' +
        `  3. the key alone in ${path}\n` +
        "Create a key at https://connect.garmin.com/app/settings/personalApiToken"
    );
  }
  warnIfWorldReadable(path, "Personal API key file");
  const key = contents.trim();
  if (!key) {
    throw new GarminConfigError(
      `The Personal API key file ${path} is empty. Save your key in it, or set ${API_KEY_ENV_VAR}.`
    );
  }
  return key;
}

/** Ties a cached token to the key and host it was issued for. */
function fingerprint(host: string, apiKey: string): string {
  return createHash("sha256").update(`${host}\0${apiKey}`).digest("hex");
}

/** Reads the `exp` claim without verifying the signature. */
function jwtExpiryMs(token: string): number {
  const segments = token.split(".");
  if (segments.length < 2) {
    throw new GarminConfigError(
      "The Garmin token endpoint did not return a JWT. The Personal API key may be malformed."
    );
  }
  let payload: { exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    throw new GarminConfigError(
      "The Garmin token endpoint returned a token whose payload could not be decoded."
    );
  }
  if (typeof payload.exp !== "number") {
    throw new GarminConfigError(
      "The Garmin token endpoint returned a JWT without an exp claim."
    );
  }
  return payload.exp * 1000;
}

function readCachedToken(expected: string): CachedToken | undefined {
  const path = tokenCachePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  warnIfWorldReadable(path, "Bearer-token cache");
  try {
    const cache = JSON.parse(raw) as {
      fingerprint?: string;
      access_token?: string;
      expires_at?: number;
    };
    if (cache.fingerprint !== expected) return undefined;
    if (!cache.access_token || typeof cache.expires_at !== "number") return undefined;
    return { accessToken: cache.access_token, expiresAt: cache.expires_at * 1000 };
  } catch {
    console.error(`Warning: ignoring unreadable bearer-token cache ${path}`);
    return undefined;
  }
}

function writeCachedToken(expected: string, token: CachedToken): void {
  const path = tokenCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        fingerprint: expected,
        access_token: token.accessToken,
        expires_at: Math.floor(token.expiresAt / 1000),
      }),
      { encoding: "utf8", mode: 0o600 }
    );
    chmodSync(path, 0o600);
  } catch (error) {
    // A token that cannot be cached is still usable for this process.
    console.error(
      `Warning: could not write the bearer-token cache ${path}: ${(error as Error).message}`
    );
  }
}

/** Exchanges the API key for a new JWT. */
async function exchangeKeyForToken(
  apiKey: string,
  signal: AbortSignal
): Promise<CachedToken> {
  const host = baseUrl();
  const url = `${host}${TOKEN_PATH}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Accept: "*/*", Authorization: `ApiKey ${apiKey}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        "Garmin's token endpoint did not respond within 30 seconds. Check your network and retry."
      );
    }
    throw error;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GarminApiError(response.status, TOKEN_PATH, body);
  }

  // The endpoint returns the raw JWT as plain text, not JSON.
  const accessToken = (await response.text()).trim();
  if (!accessToken) {
    throw new GarminConfigError(
      "Garmin's token endpoint returned an empty token. Verify the Personal API key is current."
    );
  }
  return { accessToken, expiresAt: jwtExpiryMs(accessToken) };
}

let memoized: { fingerprint: string; token: CachedToken } | undefined;
let inFlight: Promise<CachedToken> | undefined;

function isUsable(token: CachedToken): boolean {
  return token.expiresAt - Date.now() > TOKEN_REFRESH_WINDOW_MS;
}

/**
 * Returns a usable bearer token, reusing the in-memory and on-disk caches and
 * exchanging the API key only when needed. Concurrent callers share one exchange.
 */
export async function getBearerToken(
  signal: AbortSignal,
  forceRefresh = false
): Promise<string> {
  const apiKey = resolveApiKey();
  const expected = fingerprint(baseUrl(), apiKey);

  if (!forceRefresh) {
    if (memoized?.fingerprint === expected && isUsable(memoized.token)) {
      return memoized.token.accessToken;
    }
    const cached = readCachedToken(expected);
    if (cached && isUsable(cached)) {
      memoized = { fingerprint: expected, token: cached };
      return cached.accessToken;
    }
  }

  if (!inFlight) {
    inFlight = exchangeKeyForToken(apiKey, signal)
      .then((token) => {
        memoized = { fingerprint: expected, token };
        writeCachedToken(expected, token);
        return token;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  const token = await inFlight;
  return token.accessToken;
}

/** Discards the cached token so the next request exchanges the key again. */
export function invalidateToken(): void {
  memoized = undefined;
}
