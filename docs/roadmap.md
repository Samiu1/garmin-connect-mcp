# Roadmap

## Status

v1.0.1 — all 26 Garmin Connect Personal API endpoints covered by 10 tools, plus a passthrough. stdio transport only. Three credential sources: environment variable, a key command for OS keychains and password managers, and a key file. Published to npm as `@samiul_i/garmin-connect-mcp`, built and released from CI with provenance.

**Verified live against a real Garmin account.** The self-check passes with credentials, and all 25 pullable endpoints were probed directly: 23 returned data, 2 returned `204` (women's health, not tracked on that account), and none 404'd, so every path in the client is correct. The file-download endpoint has since been exercised too, against a real activity.

Per-metric field projections are implemented: `detail_level="summary"` is the default on both health tools, and a month of sleep, daily summaries or body battery now fits where it previously exceeded the response limit.

Measured on that account:

- Pruning empty values saves ~2% (1.7 KB across 88.6 KB), not the large win assumed. Garmin omits absent fields rather than nulling them; size is driven by time-series data.
- A single day of `dailyHeartRate` is 14 KB. 7 nights of `sleep` is 21.6 KB. 30 nights is 91 KB.
- `activity-service/activity/{id}` returns a **different shape** from the search endpoint, not merely a smaller one: 13 top-level keys, with every figure nested in `summaryDTO` and the type objects suffixed (`activityTypeDTO`, `eventTypeDTO`). The flat field list written for search matched only 3 of its 22 names, so `detail_level="summary"` returned an activity name and a city and nothing else — no distance, duration, heart rate or calories. Fixed with a second, shape-aware projection in `src/tools/activity.ts`; an earlier note here read the 13 keys as "the projection rarely drops much", which inverted the finding. On this payload `steps`, `vO2MaxValue` and `deviceId` do not exist at all, and aerobic training effect is named `trainingEffect`.
- Sleep is **not** an activity in Garmin's model, so it has no file to download. Over a full year this account returned 3 wellness activities, all `wellnessActivityType: "HEALTH_MONITORING"` (Health Snapshot), none sleep-related. Wellness entries carry no `activityId` of any kind — `userProfilePk`, `activityUuid` and `rulePK` instead — so `garmin_download_activity_file` is unreachable from `garmin_get_wellness_activities`; `garmin_search_activities` is its only source of IDs. A 365-day wellness range was accepted.
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

Also confirmed since: `garmin_download_activity_file` against a real recorded activity, which wrote a 76 KB ZIP holding one valid 377,750-byte FIT file, refused correctly with `overwrite=false`, and replaced the file with `overwrite=true`; Markdown rendering on real *activity* payloads at both detail levels across running, strength training and indoor cardio.

The refresh window and the 401 retry are now covered too, but **asserted offline rather than live**, since driving them for real means waiting out a 23-hour token. `getBearerToken` takes an optional `now` clock defaulting to `Date.now`, and the self-check drives it with a fabricated JWT, a throwaway `HOME` and a counting `fetch` stub, so no network call and no real cache file are involved. What it asserts: a cached token with 90 minutes left is reused with no exchange; one with 30 minutes left is re-exchanged although still valid; an expired one is re-exchanged; advancing the clock alone, with the cache untouched, is enough to trigger the refresh; a `401` on a data request forces exactly one re-exchange, with a second `401` surfacing as a credential error instead of looping, and a `401` followed by success is recovered by that one retry; and the cache the refresh rewrites is still `0600` with the same three keys. Each assertion was checked by deliberately breaking the thing it covers — widening the window to two hours, shrinking it to a minute, ignoring the injected clock, removing the retry, and retrying twice — and confirming the self-check went red in every case.

Still open:

- The empty-response branch in `apiGetBinary` (`src/api.ts`), which throws a bare `Error` rather than a `GarminApiError` and so bypasses the recovery messages in `errors.ts`. Sleep looked like a way to reach it and is not one, per the note above; no real activity has produced an empty body.
- Activity ZIPs are written with the process umask, measured as mode `644`, while the server warns on stderr about group-readable *credential* files. A FIT file holds the route's GPS trace, so the two postures disagree. The caller chooses the path, so this is a judgement call rather than a defect.
- `detail_level="full"` on an activity renders `userProfileId`, `displayname`, `fullname` and three S3 profile-image URLs. The user's own data, so not a leak, but noise in every full render.

### Resolve the spec-versus-client gap

Garmin's Python client wraps two endpoints absent from the published OpenAPI document: `/activity-service/activity/activityTypes/simple` and `/metrics-service/metrics/maxmet/daily/...` (VO2 max). Probe both with `garmin_get_raw`. If they respond, give them real tools — activity types would make `activity_type` on search discoverable, and VO2 max belongs in `garmin_get_health_trend`.

### Data-dependent evaluations

`evals/evaluation.xml` holds only questions with stable, account-independent answers. Add a private companion file generated against a real account, choosing questions over closed past periods so answers do not drift.

## Considered and rejected

### Interactive prompts for key entry

Documented, then removed. `security add-generic-password -w` with no value, and `read -rs`, both read from the tty, and in testing the former stored only the first 128 characters of a 133-character key with no error. The truncated key has a plausible shape and fails with `HTTP 401` and an empty body, which is indistinguishable from an expired key — hours of debugging for a silent 5-character loss. Root cause unproven; 128 being exactly 2^7 suggests a fixed buffer. Setup now reads the clipboard and verifies the stored length round-tripped, which is safe whatever the cause.

## Later

- **Caching.** Historical days are immutable once synced. A small on-disk cache keyed by endpoint and date would cut repeat calls during multi-day analysis.
- **Derived-metric tools.** Weekly training load, acute-to-chronic workload ratio, sleep-debt trend. These need the typed schemas above to be reliable.
- **MCPB bundle.** Package for one-click install so sharing does not require editing client config by hand.
- **Rate-limit handling.** Garmin publishes no Personal API rate limit. If `429`s appear in practice, add backoff with `Retry-After` support rather than guessing a limit now.
- **China host verification.** `GARMIN_PERSONAL_API_BASE_URL` supports `personal.connectapi.garmin.cn`, taken from the spec's server list; untested.
