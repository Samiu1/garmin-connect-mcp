/** Shared defaults for Garmin Personal API access. */

/** Global Garmin Personal API host. */
export const DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";

/** Token-exchange path. Takes `Authorization: ApiKey <key>` and returns a raw JWT. */
export const TOKEN_PATH =
  "/personalapitoken-service/personal-api/personal-api-key/token";

/** Environment variable holding the user's Personal API key. */
export const API_KEY_ENV_VAR = "GARMIN_PERSONAL_API_KEY";

/**
 * Environment variable holding a command whose stdout is the key, so it can live
 * in an OS keychain or password manager instead of in plaintext on disk.
 */
export const API_KEY_COMMAND_ENV_VAR = "GARMIN_PERSONAL_API_KEY_COMMAND";

/** How long the key command may take before it is abandoned. */
export const KEY_COMMAND_TIMEOUT_MS = 30_000;

/** Environment variable overriding the API host (e.g. the .cn host). */
export const BASE_URL_ENV_VAR = "GARMIN_PERSONAL_API_BASE_URL";

/**
 * Default key file, shared with Garmin's official Python client so a user who
 * already set that up needs no extra configuration.
 */
export const DEFAULT_API_KEY_FILE = ".config/garmin/connect-personal-api-key";

/** Bearer-token cache, in the same location and format as the official client. */
export const DEFAULT_TOKEN_CACHE_FILE =
  ".config/garmin/connect-personal-api-bearer-token.json";

/** Request timeout for a single upstream call. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Obtain a fresh token when the cached one has less than this left. */
export const TOKEN_REFRESH_WINDOW_MS = 60 * 60 * 1000;

/** Maximum characters a single tool result may contain. */
export const CHARACTER_LIMIT = 25_000;
