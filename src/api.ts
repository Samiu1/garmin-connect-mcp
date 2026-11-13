/**
 * The single place every tool goes through to reach Garmin.
 *
 * Adds bearer authorization, applies the request timeout, retries once when a
 * token has been revoked before its expiry, and turns failures into messages the
 * model can act on.
 */
import { baseUrl, getBearerToken, invalidateToken } from "./auth.js";
import { GarminApiError } from "./errors.js";
import { REQUEST_TIMEOUT_MS } from "./constants.js";

/** A query value; arrays are sent as a repeated parameter. */
export type QueryValue = string | number | boolean | string[] | undefined;

function buildUrl(path: string, query: Record<string, QueryValue>): URL {
  const url = new URL(`${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function send(
  path: string,
  query: Record<string, QueryValue>,
  signal: AbortSignal,
  accept: string,
  token: string
): Promise<Response> {
  const url = buildUrl(path, query);
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      // Aborts when the client cancels the call, or after the request timeout.
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `Garmin did not respond to ${path} within 30 seconds. Retry, or request a narrower date range.`
      );
    }
    throw error;
  }
}

/**
 * Performs an authenticated GET and returns decoded JSON.
 *
 * Garmin answers "no data for this date" with 204 No Content on several
 * endpoints, which becomes `null` rather than an error.
 */
export async function apiGet<T = unknown>(
  path: string,
  query: Record<string, QueryValue>,
  signal: AbortSignal
): Promise<T | null> {
  let token = await getBearerToken(signal);
  let response = await send(path, query, signal, "application/json", token);

  // A token can stop working before it expires, for example when the key is
  // deleted and recreated. One forced exchange distinguishes that from a real 401.
  if (response.status === 401) {
    invalidateToken();
    token = await getBearerToken(signal, true);
    response = await send(path, query, signal, "application/json", token);
  }

  if (response.status === 204) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GarminApiError(response.status, path, body);
  }

  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Garmin returned a non-JSON response for ${path}. This usually means the endpoint path is wrong.`
    );
  }
}

/** Performs an authenticated GET and returns the raw bytes, for file downloads. */
export async function apiGetBinary(
  path: string,
  signal: AbortSignal
): Promise<Uint8Array> {
  let token = await getBearerToken(signal);
  let response = await send(path, {}, signal, "application/x-zip-compressed, */*", token);

  if (response.status === 401) {
    invalidateToken();
    token = await getBearerToken(signal, true);
    response = await send(path, {}, signal, "application/x-zip-compressed, */*", token);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GarminApiError(response.status, path, body);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error(
      `Garmin returned an empty file for ${path}. The activity may have no uploaded file.`
    );
  }
  return new Uint8Array(buffer);
}
