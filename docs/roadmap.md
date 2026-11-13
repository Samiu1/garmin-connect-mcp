# Roadmap

## Status

v1.0.0 — all 26 Garmin Connect Personal API endpoints covered by 10 tools, plus a passthrough. stdio transport only. Three credential sources: environment variable, a key command for OS keychains and password managers, and a key file. Packaged for npm but not yet published.

**Verified live against a real Garmin account.** The self-check passes with credentials, and all 25 pullable endpoints were probed directly: 23 returned data, 2 returned `204` (women's health, not tracked on that account), and none 404'd, so every path in the client is correct. The file-download endpoint was not probed because it writes to disk.

Per-metric field projections are implemented: `detail_level="summary"` is the default on both health tools, and a month of sleep, daily summaries or body battery now fits where it previously exceeded the response limit.

Measured on that account:
- Pruning empty values saves ~2% (1.7 KB across 88.6 KB), not the large win assumed. Garmin omits absent fields rather than nulling them; size is driven by time-series data.
- A single day of `dailyHeartRate` is 14 KB. 7 nights of `sleep` is 21.6 KB. 30 nights is 91 KB.
- `activity-service/activity/{id}` returned 13 keys, far fewer than the 230 the schema allows, so the summary projection rarely drops much.
- Garmin caps `steps` and `stress` at 28 days per request and `hydration` at 31, answering anything longer with a bare `HTTP 400`. Not in the spec; found by bisection. `hrv`, `weight` and wellness activities accepted a full year.
- `usersummary-service/v2/dailysummaries` groups figures into nested category objects (`movement.steps`, `heartRate.restingValue`) rather than the flat names `usersummary/daily` uses, so projections need explicit paths per version.

## Where the endpoint list came from

Worth recording, because it is not obvious and cost real time to work out.

The [Personal API Swagger page](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/) renders client-side, so fetching its HTML returns navigation and no endpoints. The OpenAPI document is not served as a file either; it is embedded in the page's JavaScript bundle as a `JSON.parse('...')` argument. To recover it:

1. Load the page in a real browser and read the network log for the page's component chunk, named `component---src-pages-gc-developer-program-personal-swagger-docs-js-*.js`.
2. Download that chunk and find the substring `{"openapi"`.
3. Walk left to the enclosing `JSON.parse('`, read to the matching unescaped `'`, and unescape the JavaScript string literal: `\\'` to `'` and `\\\\` to `\\`, leaving other escapes for the JSON parser.
4. `json.loads` the result.

That yields OpenAPI 3.0.1, `Garmin Connect Personal API` 1.0.0: 26 paths, 109 schemas, servers `personal.connectapi.garmin.com` and `personal.connectapi.garmin.cn`. The document declares no `securitySchemes`, so the auth flow comes from the Personal API page and FAQ, not the spec.

The spec is not vendored here, to avoid redistributing Garmin's document. Re-extract it when checking whether endpoints have changed.

## Next

### Remaining live verification
Already confirmed: the token exchange returns a 3-segment JWT whose `exp` parses and sits 23.94 hours out; the cache is written `0600` with the `fingerprint`/`access_token`/`expires_at` shape and is reused by a separate process without re-exchanging; all seven `garmin_get_daily_health` metrics return data on the test account; Markdown rendering was exercised on a real 7-night sleep payload.

Still open:
- The forced re-exchange inside the one-hour refresh window. Needs an injectable clock to test without waiting 23 hours — worth adding, since this is the path that keeps long-running sessions alive.
- Markdown rendering on a real *activity* payload, as opposed to a health payload.
- `garmin_download_activity_file` against a real activity, including the `overwrite=false` refusal. Skipped so far because it writes to disk.

### Resolve the spec-versus-client gap
Garmin's Python client wraps two endpoints absent from the published OpenAPI document: `/activity-service/activity/activityTypes/simple` and `/metrics-service/metrics/maxmet/daily/...` (VO2 max). Probe both with `garmin_get_raw`. If they respond, give them real tools — activity types would make `activity_type` on search discoverable, and VO2 max belongs in `garmin_get_health_trend`.

### Data-dependent evaluations
`evals/evaluation.xml` holds only questions with stable, account-independent answers. Add a private companion file generated against a real account, choosing questions over closed past periods so answers do not drift.

## Considered and rejected

### Interactive prompts for key entry
Documented, then removed. `security add-generic-password -w` with no value, and `read -rs`, both read from the tty, and in testing the former stored only the first 128 characters of a 133-character key with no error. The truncated key has a plausible shape and fails with `HTTP 401` and an empty body, which is indistinguishable from an expired key — hours of debugging for a silent 5-character loss. Root cause unproven; 128 being exactly 2^7 suggests a fixed buffer. Setup now reads the clipboard and verifies the stored length round-tripped, which is safe whatever the cause.


### Gating tools on device capability
Registering only the tools a user's watch supports. Rejected: the Personal API exposes no device inventory (`DeviceMetaDataDTO` describes the device behind a single wellness activity; `UserSettingsDTO` carries only display preferences), capability would not predict data presence anyway, and a startup handshake would add a round-trip per HTTP request and make an expired key prevent startup. Availability is reported per response instead. See README, "Why tools are not gated on device capability".

### Shipping a Streamable HTTP transport
Built, then removed before publishing. The SDK's HTTP handler verifies no tokens, and this server reads a person's full health history, so an HTTP listener is only safe with authentication in front of the route. Publishing one unauthenticated to npm would make that the default mistake. Removing it also dropped the runtime dependencies from five to two, which matters for a package people fetch with `npx -y`.

To bring it back, add it together with its auth: `requireBearerAuth` on the `/mcp` route with `expectedResource` set to the server's own URL, a `HOST` environment variable so it can bind `0.0.0.0` in a container, and `allowedHosts` for the Host-header check. Do not add the transport without the auth.

### Hand-written Zod schemas for all 109 response types
Rejected for now: high maintenance against an API that changes without notice, and the generic renderer cannot throw on an unexpected shape. Revisit for the handful of payloads worth strong typing, most likely daily summary and activity summary, where a typed shape would let tools compute derived values such as week-over-week deltas.

## Later

- **Caching.** Historical days are immutable once synced. A small on-disk cache keyed by endpoint and date would cut repeat calls during multi-day analysis.
- **Derived-metric tools.** Weekly training load, acute-to-chronic workload ratio, sleep-debt trend. These need the typed schemas above to be reliable.
- **MCPB bundle.** Package for one-click install so sharing does not require editing client config by hand.
- **Rate-limit handling.** Garmin publishes no Personal API rate limit. If `429`s appear in practice, add backoff with `Retry-After` support rather than guessing a limit now.
- **China host verification.** `GARMIN_PERSONAL_API_BASE_URL` supports `personal.connectapi.garmin.cn`, taken from the spec's server list; untested.
