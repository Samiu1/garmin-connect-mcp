# garmin-connect-mcp

An MCP server for the [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/). Each user brings their own Personal API key, so the server holds no shared credentials and can be installed by anyone with a Garmin account.

Ten tools cover all 26 endpoints in the Personal API, plus a passthrough for anything Garmin adds later.

## Requirements

- Node.js 20.3 or newer
- A Garmin Connect Personal API key

## Get a Personal API key

The Personal API gives you read access to **your own** Garmin Connect data with a key you issue yourself. There is no OAuth app to register and no approval process.

**Before you start:** you need a Garmin Connect account with at least one synced device. The key page exists only on Garmin Connect **web** — it is not in the mobile app.

### Steps

1. **Sign in** to Garmin Connect: <https://connect.garmin.com>
2. **Open the Personal API token page:** <https://connect.garmin.com/app/settings/personalApiToken>
   In the web UI you can also reach it under **Settings → Account → Personal API Token**.
3. Choose **Create Key**.
4. **Accept the terms.** They cover personal, non-commercial use.
5. **Pick an expiration:** 30 days, 90 days, 180 days, or one year. Longer means fewer rotations; shorter limits the damage if the key leaks.
6. Choose **Create**.
7. **Copy the key immediately.** It is shown once and cannot be retrieved afterwards. If you lose it, delete that key and create another.
8. **Store it** — see [Store your key](#store-your-key). Do not paste it into an interactive terminal prompt; the warning there explains why.
9. **Check it works** — see [Verify the key works](#verify-the-key-works) — before configuring any client.

### What the key looks like

A URL-safe string of roughly 130 characters, containing dots. One real key measured exactly 133 characters.

That length is worth noting, because a **truncated key is the hardest failure to diagnose**: it has a valid shape, and Garmin rejects it with `HTTP 401` and an empty body, which is identical to how it rejects an expired or deleted key. Always compare the number of characters you stored against the key you copied.

### Expiry and rotation

Garmin emails a reminder about a week before a key expires. When it does, create a new one and re-store it — nothing else about your setup changes. Deleting a key invalidates it immediately, along with every access token issued from it.

### Troubleshooting

| What you see | Likely cause |
| --- | --- |
| `HTTP 401`, empty body, on the token request | Key truncated, expired, or deleted. Compare the stored length, and confirm a key is still listed on the token page. |
| `HTTP 400` on the token request | No `Authorization` header reached Garmin. |
| `HTTP 400` on a data request | A malformed date, or a range longer than that metric allows — see [Undocumented date-range limits](#undocumented-date-range-limits). |
| No key listed on the token page | It expired or was deleted. Create a new one. |
| Server exits at startup with "No Garmin Personal API key found" | None of the three sources supplied a key, or an MCP client did not pass the variable through to the server process. |

### Reference

- [Personal API overview](https://developer.garmin.com/gc-developer-program/personal/personal-api/) — what the program is, and the token-exchange call
- [Personal API FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/) — terms, expiry options, what the key covers
- [Personal API Swagger docs](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/) — the endpoint reference this server implements
- [Garmin's official Python client](https://github.com/garmin/connect-personal-api-python) — reads the same key-file path this server does
- [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/overview/) — the business and enterprise programs, if you outgrow personal use

**Scope:** the Personal API is for your own data. Garmin states it is not intended for commercial applications serving multiple end users; the developer program above covers that case.

## Store your key

The server checks three sources, in this order:

1. `GARMIN_PERSONAL_API_KEY` in the environment
2. `GARMIN_PERSONAL_API_KEY_COMMAND` — a command whose stdout is the key
3. `~/.config/garmin/connect-personal-api-key` — the file holds the key alone; surrounding whitespace, including a trailing newline, is ignored

Personal API keys expire after 30 days to a year, so you will rotate this key on a schedule, not once. Pick a source that makes rotation one edit rather than one per client.

### Option A: OS keychain or password manager (most secure)

The key stays encrypted at rest and never appears in a file you might commit.

> **Do not paste the key into an interactive prompt.** In testing, `security add-generic-password -w` with no value stored only the first 128 characters of a 133-character key, silently. The result looks valid, has the right shape, and fails with `HTTP 401` and an empty body — which is indistinguishable from an expired key. Store it from the clipboard instead, and verify the length round-tripped.

Copy the key from Garmin, then on macOS:

```bash
K=$(pbpaste | tr -d '\r\n'); security add-generic-password -a "$USER" -s garmin-personal-api -l "Garmin Connect Personal API" -U -w "$K"; S=$(security find-generic-password -s garmin-personal-api -w | tr -d '\n'); [ "$S" = "$K" ] && echo "stored ${#S} chars, round-trip OK" || echo "MISMATCH: clipboard ${#K}, stored ${#S}"; unset K S
```

That prints `round-trip OK` with the character count, or tells you the two lengths disagree. One caveat of passing the key as an argument this way: it is briefly visible to `ps` for other processes on the machine. On a single-user machine that is a small exposure; if it matters to you, use option B, which avoids it entirely.

Then point the server at it:

```bash
export GARMIN_PERSONAL_API_KEY_COMMAND="security find-generic-password -s garmin-personal-api -w"
```

The same hook works with any secret store that can print to stdout:

| Store | Command |
| --- | --- |
| macOS Keychain | `security find-generic-password -s garmin-personal-api -w` |
| 1Password CLI | `op read "op://Private/Garmin/credential"` |
| pass | `pass show garmin/personal-api` |
| Bitwarden CLI | `bw get password garmin-personal-api` |

The command runs once per server start and its result is held in memory, so there is no subprocess or keychain prompt per request. Rotating the stored secret takes effect on the next restart. The command must print the key and nothing else; a failure or empty output stops startup with an explanation rather than starting a broken server.

### Option B: key file (simplest)

One file, shared by every MCP client and by [Garmin's official Python client](https://github.com/garmin/connect-personal-api-python), which reads the same path. Your client configuration contains no secret.

Copy the key from Garmin, then write it straight from the clipboard. This avoids both your shell history and any interactive prompt, and never passes the key as a command argument:

```bash
mkdir -p ~/.config/garmin && pbpaste | tr -d '\r\n' > ~/.config/garmin/connect-personal-api-key && chmod 600 ~/.config/garmin/connect-personal-api-key && echo "stored $(wc -c < ~/.config/garmin/connect-personal-api-key | tr -d ' ') chars, mode $(stat -f '%Lp' ~/.config/garmin/connect-personal-api-key)"
```

Check the character count against the key you copied. To rotate later, copy the new key and run the same command.

On Linux, replace `pbpaste` with `xclip -o -selection clipboard` or `wl-paste`, and `stat -f '%Lp'` with `stat -c '%a'`.

Avoid `read -rs` and other interactive prompts for this, for the reason given in option A: a prompt can truncate a long key without saying so.

On Windows, write the file from the clipboard with PowerShell, then confirm the length:

```powershell
$dir = "$HOME\.config\garmin"; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $k = (Get-Clipboard) -replace '\s',''; [IO.File]::WriteAllText("$dir\connect-personal-api-key", $k); "stored $($k.Length) chars"
```

### Option C: environment variable

Best for a one-off run, a CI job, or a shell where you want to override the others temporarily:

```bash
GARMIN_PERSONAL_API_KEY=... npx -y @samiul_i/garmin-connect-mcp@1.0.0
```

Putting the key in an MCP client's `env` block works, since that reaches the server as this variable. It is the weakest option: it lands in plaintext in a config file that is routinely screenshotted and committed to dotfiles repositories, it has no guaranteed permissions, and it needs editing in every client each time the key expires.

Note that with options A and C, the MCP client must pass the variable through to the server process. Clients give the child a minimal environment, so set it in the client's `env` block rather than relying on your shell profile — `export` in `.zshrc` will not reach a server launched by a desktop app.

Whichever you choose: the server never logs the key, and warns on stderr if the key file or token cache is readable by other users.

### Verify the key works

Do this before configuring a client, so a bad key fails in one obvious place rather than as a silent tool error later.

From the keychain (option A):

```bash
curl -sS -o /dev/null -w 'token exchange: HTTP %{http_code}\n' -X POST "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token" -H 'Accept: */*' -H "Authorization: ApiKey $(security find-generic-password -s garmin-personal-api -w | tr -d '\n')"
```

From the key file (option B):

```bash
curl -sS -o /dev/null -w 'token exchange: HTTP %{http_code}\n' -X POST "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token" -H 'Accept: */*' -H "Authorization: ApiKey $(tr -d '\n' < ~/.config/garmin/connect-personal-api-key)"
```

`HTTP 200` means the key works and the server will too. `HTTP 401` means Garmin rejected it — see [Troubleshooting](#troubleshooting).

### All environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GARMIN_PERSONAL_API_KEY` | — | The key itself (option C) |
| `GARMIN_PERSONAL_API_KEY_COMMAND` | — | A command printing the key (option A) |
| `GARMIN_PERSONAL_API_BASE_URL` | `https://personal.connectapi.garmin.com` | Set to `https://personal.connectapi.garmin.cn` for Garmin China accounts |

Copy `.env.example` if you prefer a file. Never commit the key.

## Install in a client

With your key in `~/.config/garmin/connect-personal-api-key`, the configuration carries no secret:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["-y", "@samiul_i/garmin-connect-mcp@1.0.0"]
    }
  }
}
```

Where that goes:

| Client | Location |
| --- | --- |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `.mcp.json` in the project, or `claude mcp add garmin -- npx -y @samiul_i/garmin-connect-mcp@1.0.0` |
| Cursor | `~/.cursor/mcp.json` |

Restart the client after editing, then ask it something like "what did my Garmin record yesterday?"

Pin the version rather than floating on `@latest`: `npx -y <name>` fetches the newest release every launch, and this server is handed a credential at startup. Pinning means a future release cannot receive your key until you choose to upgrade.

If you chose the keychain (option A), add the command instead. This is still a config file with no secret in it — only an instruction for fetching one:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["-y", "@samiul_i/garmin-connect-mcp@1.0.0"],
      "env": {
        "GARMIN_PERSONAL_API_KEY_COMMAND": "security find-generic-password -s garmin-personal-api -w"
      }
    }
  }
}
```

If you would rather paste the key itself, use `"env": { "GARMIN_PERSONAL_API_KEY": "your-key-here" }` and read the trade-offs in [Store your key](#store-your-key) first.

## What you can ask

Once it is connected, these all work as plain requests. Each maps onto one or two tool calls.

- "How did I sleep last night?" → `garmin_get_daily_health` with `metrics=["sleep"]`
- "Show my sleep trend this month" → `garmin_get_health_trend`, `metric="sleep"`
- "What's my resting heart rate doing over the last three weeks?" → `garmin_get_health_trend`, `metric="daily_summaries"`
- "List my runs in October" → `garmin_search_activities` with `activity_type="running"` and a date range
- "Break down my longest ride this year" → `garmin_search_activities` sorted by distance, then `garmin_get_activity`
- "Was yesterday a recovery day?" → `garmin_get_daily_health` with `metrics=["summary","sleep","hrv"]`
- "Which heart-rate zone was my last race in?" → `garmin_get_activity` plus `garmin_get_heart_rate_zones`
- "Save the GPS file from my last hike" → `garmin_search_activities`, then `garmin_download_activity_file`

Two things to expect, both deliberate:

- **Figures come back in Garmin's units** — metres and seconds — regardless of your display preferences. Ask for your preferred units, or have the client call `garmin_get_user_profile` first.
- **Missing data is reported as missing, never as zero.** If a metric your device does not record is requested, the response names it under `metrics_unavailable` rather than returning `0`.

## Develop

```bash
npm install
```

```bash
npm run build
```

```bash
npm run smoke
```

```bash
npm run dev
```

- `npm run build` compiles to `dist/`, with `dist/index.js` as the entry point.
- `npm run smoke` starts the built server and exercises it as a client. It passes **without** credentials, checking the tool manifest, argument validation, path safety, and the key-command failure modes. It prints which credential source it found, and if any of the three supplies a key it also makes live read-only calls: a month of each wide metric, the summary-versus-full size difference, and the date-range limits.
- `npm run dev` runs from source with reload.
- `npx @modelcontextprotocol/inspector node dist/index.js` opens an interactive UI.

## Publish

`prepublishOnly` builds and runs the self-check, so a broken build cannot be published.

```bash
npm publish
```

Before the first publish:

- The package publishes as **`@samiul_i/garmin-connect-mcp`**. Scoped packages default to restricted, so `publishConfig.access` is set to `public` in `package.json`; without it, `npm publish` fails or publishes privately.
- Add `repository`, `homepage`, and `bugs` to `package.json` once the code is on a git host. npm renders them on the package page, and their absence is the most visible gap on a fresh listing.
- `npm whoami` to confirm you are logged in.

Only `dist/`, `README.md`, and `LICENSE` ship. Verify with `npm pack --dry-run`.

## Transport

stdio only, by design. The client launches the server as a subprocess, and the Personal API key never leaves the user's machine.

There is deliberately no HTTP transport. The SDK's HTTP handler verifies no tokens of its own, and this server reads a person's complete health history, so an HTTP listener would need authentication in front of it to be safe off-device. Shipping one unauthenticated in a public package would invite exactly that mistake. See `docs/roadmap.md` if you want to add HTTP and auth together.

## Architecture

```
src/
  index.ts        createServer() factory, server instructions, stdio transport
  constants.ts    Hosts, paths, timeouts, character limit
  auth.ts         Key resolution, ApiKey -> JWT exchange, token cache
  api.ts          The one authenticated GET path every tool uses
  errors.ts       HTTP status -> recovery-oriented message
  format.ts       Input schemas, empty-value pruning, Markdown/JSON rendering
  tools/
    activity.ts       Search, detail, wellness activities, file download
    health.ts         Daily snapshot, single-metric trend, heart-rate zones
    profile.ts        Units and locale settings
    womens-health.ts  Menstrual cycle summary and day view
    raw.ts            Passthrough for uncovered endpoints
scripts/smoke.ts  Self-check client
evals/            Evaluation questions
```

### Authentication

The Personal API key is **not** accepted on data requests. `auth.ts` exchanges it for a bearer token:

```
POST /personalapitoken-service/personal-api/personal-api-key/token
Authorization: ApiKey <your key>
```

The response body is the raw JWT as plain text, not JSON. Expiry comes from the token's `exp` claim; tokens last 24 hours and there are no refresh tokens, so a new one is obtained when under an hour remains. Tokens are cached in `~/.config/garmin/connect-personal-api-bearer-token.json` with mode `0600`, in the same format as Garmin's Python client, keyed by a fingerprint of the host and key. A `401` on a data request triggers one forced re-exchange, which separates a revoked token from a genuinely bad key.

The server warns on stderr if either credential file is readable by other users.

## Tools

All tools are read-only except `garmin_download_activity_file`, which writes a ZIP to a path you give it.

| Tool | Covers |
| --- | --- |
| `garmin_search_activities` | Activity search with date, type, distance, duration, elevation, power, and event filters; paginated |
| `garmin_get_activity` | One activity's detail, optionally with its structured workout steps |
| `garmin_get_wellness_activities` | Auto-detected wellness activities over a date range |
| `garmin_download_activity_file` | The original activity file, as a ZIP, saved to disk |
| `garmin_get_daily_health` | One date, any of: summary, sleep, heart rate, HRV, SpO2, fitness age, nutrition |
| `garmin_get_health_trend` | One metric over a date range: steps, stress, hydration, daily summaries, sleep, HRV, body battery, weight, all weigh-ins, weight goals |
| `garmin_get_heart_rate_zones` | Configured heart-rate training zones |
| `garmin_get_user_profile` | Display name, locale, time zone, unit preferences |
| `garmin_get_menstrual_cycle` | Cycle summary or detailed day view |
| `garmin_get_raw` | Any Personal API path, for endpoints and parameters the above omit |

Every data tool takes `response_format`: `markdown` (default) for readable text, `json` for exact Garmin field names with `structuredContent`. `garmin_get_activity`, `garmin_get_daily_health` and `garmin_get_health_trend` also take `detail_level`, defaulting to `summary`.

## Design decisions

### Sparse data across devices

Garmin watches differ in sensors, and a given day's data also depends on whether a feature was enabled and whether the watch was worn. `SummarizedActivityDTO` alone has 230 properties, most specific to one sport.

Three things follow from that:

- **Empty values are pruned.** `null`, `undefined`, `""`, `[]`, and `{}` are removed recursively from both output formats. `0` and `false` are **kept** — zero steps and a false nap flag are real measurements, and dropping them would be indistinguishable from an absent sensor. Pass `include_empty_fields=true` to see the raw shape.

  **Measured: this saves about 2%, not the large win originally assumed.** Across 88.6 KB of real payloads from one account, pruning removed 1.7 KB. The premise was wrong: Garmin largely *omits* fields it has no data for rather than returning them as `null`, so responses are dense, not null-padded. What actually drives response size is time-series data — a single day of `dailyHeartRate` is 14 KB of real readings. Pruning is kept because it is free, keeps Markdown readable, and may matter more on accounts sparser than the one measured, but the levers that matter are `detail_level` and narrow date ranges.
- **Availability is stated, not implied.** `garmin_get_daily_health` always returns `metrics_with_data` and `metrics_unavailable`, plus a note explaining that an unavailable metric means absent sensor, disabled feature, unworn device, or unsynced data — never a zero reading. Without this, pruning and a genuine zero look the same to a model.
- **Summary and deep dive are separate.** `garmin_get_activity`, `garmin_get_daily_health` and `garmin_get_health_trend` all take `detail_level`, defaulting to `"summary"`, and the trend tool takes one metric per call so responses stay bounded. This is where the real savings are, and unlike pruning they were worth measuring:

  | Request | `full` | `summary` |
  | --- | --- | --- |
  | One day of `heart_rate` | 14,239 B | ~190 B |
  | 30 nights of `sleep` | over the limit | 19,455 chars |
  | 30 days of `daily_summaries` | 75,289 chars | 17,336 chars |
  | 30 days of `body_battery` | over the limit | 8,846 chars |
  | Daily snapshot, all 7 metrics | over the limit | 7,419 chars |

  Summary mode omits raw per-sample series — `heartRateValues` alone is 720 readings and 97% of a day's heart-rate payload — and keeps the figures callers ask for, such as `restingHeartRate`, `deepSleepSeconds` and `averageSpO2`. Omissions are replaced with a note saying how many samples were dropped and that `detail_level="full"` returns them, so nothing disappears silently. `full` is unchanged and still exceeds the limit on wide ranges, which the tool reports.

### Why tools are not gated on device capability

A tempting design is to query the user's hardware at startup and register only the tools their watch supports. This server does not, for three reasons:

1. **There is no device endpoint.** The Personal API has 26 paths and none of them list devices. `DeviceMetaDataDTO` is referenced by exactly one schema, `WellnessActivitySummaryDTO`, so it identifies the device that recorded one wellness activity. `UserSettingsDTO` carries only display and locale preferences, with no capability flags.
2. **Capability does not imply data.** A top-end watch still returns nothing for sleep on a night it was not worn, or for a feature enabled last week. Gating on hardware would hide working tools and keep non-working ones.
3. **It would make startup fragile.** Making tool registration depend on a network call turns an expired key into a server that will not start, instead of a per-call error the model can report. It would also add a Garmin round-trip to startup, and to every request under any future HTTP transport, where the server factory runs per request.

Grouping already keeps the manifest at ten tools, so gating would remove one or two at best.

### Undocumented date-range limits

Garmin caps some ranges and answers an over-long request with a bare `HTTP 400` and no explanation. The limits are not in the OpenAPI document; these were found by bisecting real requests:

| Metric | Longest accepted range |
| --- | --- |
| `steps`, `stress` | 28 days |
| `hydration` | 31 days |
| `hrv`, `weight`, `weight_all`, `weight_goals`, wellness activities | 365 days, no limit found |

`garmin_get_health_trend` enforces the known caps locally and says how to split the request, rather than forwarding a `400` that reads like a malformed date. If Garmin changes a limit, the server's message will be wrong before the API's is — the numbers live in `MAX_RANGE_DAYS` in `src/tools/health.ts`.

### Response validation

The API defines 109 response schemas. Rather than hand-maintain Zod mirrors of all of them, responses are rendered generically: a null-safe Markdown renderer, or exact JSON. Nothing calls `.parse()` on a Garmin payload, so a field Garmin adds or omits cannot throw. The trade-off is that upstream data is not schema-validated; `response_format="json"` returns what Garmin actually sent.

### Known gaps between sources

Garmin's Python client wraps two endpoints that are **not** in the published OpenAPI document: `/activity-service/activity/activityTypes/simple` and `/metrics-service/metrics/maxmet/daily/...` (VO2 max). They are not given dedicated tools here; if your account serves them, reach them through `garmin_get_raw`. Conversely the spec includes `/usersummary-service/usersummary/daily` and `/weight-service/weight/all/...`, which that client does not wrap — both are covered here.

## Security

- The key is read from the environment or a `0600`-style file, never hardcoded, and never logged.
- `garmin_get_raw` accepts a path, not a URL: full URLs, protocol-relative paths, embedded schemes, `..`, and whitespace are rejected, so requests cannot be redirected off the configured host.
- Logging goes to stderr; stdout carries only the JSON-RPC stream. The key is never written to either.
- stdio only, so the server is reachable solely by the process that launched it. No network listener is opened.

## License

MIT
