/** Error types whose messages are written for the model to act on. */

/**
 * Maps an upstream HTTP status to a message that says how to recover.
 * Thrown errors reach the model as the tool result's text.
 */
export function httpErrorMessage(status: number, path: string): string {
  switch (status) {
    case 400:
      return `Garmin rejected the request to ${path} as malformed (HTTP 400). Check that dates are YYYY-MM-DD and that the date range is ordered and not in the future.`;
    case 401:
      return "Garmin rejected the credentials (HTTP 401). The Personal API key may have expired or been deleted. Create a new key at https://connect.garmin.com/app/settings/personalApiToken and update GARMIN_PERSONAL_API_KEY.";
    case 403:
      return `Garmin denied access to ${path} (HTTP 403). The Personal API key does not cover this data, or the account has not consented to it.`;
    case 404:
      return `Garmin has no resource at ${path} (HTTP 404). Check the identifier; garmin_search_activities returns valid activity IDs.`;
    case 429:
      return "Garmin rate-limited the request (HTTP 429). Wait about a minute, then retry with a narrower date range.";
    case 500:
    case 502:
    case 503:
      return `Garmin returned a server error for ${path} (HTTP ${status}). This is usually transient; retry shortly.`;
    default:
      return `Garmin returned HTTP ${status} for ${path}.`;
  }
}

/** An unsuccessful upstream response. Keeps the status so callers can branch on it. */
export class GarminApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body?: string
  ) {
    super(httpErrorMessage(status, path));
    this.name = "GarminApiError";
  }
}

/** A configuration or local-state problem, rather than an upstream failure. */
export class GarminConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarminConfigError";
  }
}
