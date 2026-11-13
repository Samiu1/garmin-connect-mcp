# garmin-personal-mcp-server

An MCP server for the [Garmin Connect Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/). Each user brings their own Personal API key, so the server holds no shared credentials and can be installed by anyone with a Garmin account.

Ten tools cover all 26 endpoints in the Personal API, plus a passthrough for anything Garmin adds later.

## Requirements

- Node.js 20.3 or newer
- A Garmin Connect Personal API key

## Get a Personal API key

1. Open <https://connect.garmin.com/app/settings/personalApiToken> while signed in to Garmin Connect.
2. Choose **Create Key**, accept the terms, and pick an expiration: 30, 90, or 180 days, or one year.
3. Copy the key. **It is shown once and cannot be retrieved again.**

Garmin emails a reminder about a week before the key expires. Deleting a key immediately invalidates it and every access token made from it.

The Personal API is for reading your own data. Garmin states it is not intended for commercial applications serving multiple end users.

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

Confirm Garmin accepts it before wiring anything up:

```bash
curl -sS -o /dev/null -w 'token exchange: HTTP %{http_code}\n' -X POST "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token" -H 'Accept: */*' -H "Authorization: ApiKey $(security find-generic-password -s garmin-personal-api -w | tr -d '\n')"
```

`HTTP 200` means the key works. `HTTP 401` means Garmin rejected it — check that a key is listed at <https://connect.garmin.com/app/settings/personalApiToken>, and that the stored length matches what you copied.

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

### Option C: environment variable

Best for a one-off run, a CI job, or a shell where you want to override the others temporarily:

```bash
GARMIN_PERSONAL_API_KEY=... npx garmin-personal-mcp-server
```

Putting the key in an MCP client's `env` block works, since that reaches the server as this variable. It is the weakest option: it lands in plaintext in a config file that is routinely screenshotted and committed to dotfiles repositories, it has no guaranteed permissions, and it needs editing in every client each time the key expires.

Note that with options A and C, the MCP client must pass the variable through to the server process. Clients give the child a minimal environment, so set it in the client's `env` block rather than relying on your shell profile — `export` in `.zshrc` will not reach a server launched by a desktop app.

Whichever you choose: the server never logs the key, and warns on stderr if the key file or token cache is readable by other users.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GARMIN_PERSONAL_API_KEY` | — | Your Personal API key |
| `GARMIN_PERSONAL_API_BASE_URL` | `https://personal.connectapi.garmin.com` | Set to `https://personal.connectapi.garmin.cn` for Garmin China accounts |

Copy `.env.example` if you prefer a file. Never commit the key.

## Install in a client

With your key in `~/.config/garmin/connect-personal-api-key`, the configuration carries no secret:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["-y", "garmin-personal-mcp-server@1.0.0"]
    }
  }
}
```

Where that goes:

| Client | Location |
| --- | --- |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `.mcp.json` in the project, or `claude mcp add garmin -- npx -y garmin-personal-mcp-server@1.0.0` |
| Cursor | `~/.cursor/mcp.json` |

Restart the client after editing, then ask it something like "what did my Garmin record yesterday?"

Pin the version rather than floating on `@latest`: `npx -y <name>` fetches the newest release every launch, and this server is handed a credential at startup. Pinning means a future release cannot receive your key until you choose to upgrade.

If you chose the keychain (option A), add the command instead. This is still a config file with no secret in it — only an instruction for fetching one:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["-y", "garmin-personal-mcp-server@1.0.0"],
      "env": {
        "GARMIN_PERSONAL_API_KEY_COMMAND": "security find-generic-password -s garmin-personal-api -w"
      }
    }
  }
}
```

If you would rather paste the key itself, use `"env": { "GARMIN_PERSONAL_API_KEY": "your-key-here" }` and read the trade-offs in [Store your key](#store-your-key) first.

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
- `npm run smoke` starts the built server and exercises it as a client. It passes **without** credentials, checking the tool manifest, argument validation, and path safety. With `GARMIN_PERSONAL_API_KEY` set it also makes live read-only calls.
- `npm run dev` runs from source with reload.
- `npx @modelcontextprotocol/inspector node dist/index.js` opens an interactive UI.

## Publish

`prepublishOnly` builds and runs the self-check, so a broken build cannot be published.

```bash
npm publish
```

Before the first publish: claim the name with `npm view garmin-personal-mcp-server`, and add `repository`, `homepage`, and `bugs` fields to `package.json` once the code is on a git host — npm renders them on the package page.

Only `dist/`, `README.md`, and `LICENSE` ship. Verify with `npm pack --dry-run`.

### Transport

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

Every data tool takes `response_format`: `markdown` (default) for readable text, `json` for exact Garmin field names with `structuredContent`.

## Design decisions

### Sparse data across devices

Garmin watches differ in sensors, and a given day's data also depends on whether a feature was enabled and whether the watch was worn. `SummarizedActivityDTO` alone has 230 properties, most specific to one sport.

Three things follow from that:

- **Empty values are pruned.** `null`, `undefined`, `""`, `[]`, and `{}` are removed recursively from both output formats. `0` and `false` are **kept** — zero steps and a false nap flag are real measurements, and dropping them would be indistinguishable from an absent sensor. Pass `include_empty_fields=true` to see the raw shape.

  **Measured: this saves about 2%, not the large win originally assumed.** Across 88.6 KB of real payloads from one account, pruning removed 1.7 KB. The premise was wrong: Garmin largely *omits* fields it has no data for rather than returning them as `null`, so responses are dense, not null-padded. What actually drives response size is time-series data — a single day of `dailyHeartRate` is 14 KB of real readings. Pruning is kept because it is free, keeps Markdown readable, and may matter more on accounts sparser than the one measured, but the levers that matter are `detail_level` and narrow date ranges.
- **Availability is stated, not implied.** `garmin_get_daily_health` always returns `metrics_with_data` and `metrics_unavailable`, plus a note explaining that an unavailable metric means absent sensor, disabled feature, unworn device, or unsynced data — never a zero reading. Without this, pruning and a genuine zero look the same to a model.
- **Summary and deep dive are separate.** `garmin_get_activity` defaults to `detail_level="summary"` (~22 sport-agnostic fields) and offers `"full"`. `garmin_get_health_trend` takes one metric per call so responses stay bounded.

  **This is only half done.** Activities get a curated field projection; health metrics do not, and they need one. Measured against a real account: 7 nights of `sleep` is 21.6 KB and already truncates in Markdown, and 30 nights is 91 KB, which exceeds the JSON limit and returns an error asking for a narrower range. Both limit paths behave correctly, but "my sleep this month" is an ordinary request that does not fit. Note also that Markdown is *bulkier* than JSON here — the generic renderer spends a line per key, which costs more than JSON's repeated field names. The fix is a per-metric field projection, as tracked in `docs/roadmap.md`.

### Why tools are not gated on device capability

A tempting design is to query the user's hardware at startup and register only the tools their watch supports. This server does not, for three reasons:

1. **There is no device endpoint.** The Personal API has 26 paths and none of them list devices. `DeviceMetaDataDTO` is referenced by exactly one schema, `WellnessActivitySummaryDTO`, so it identifies the device that recorded one wellness activity. `UserSettingsDTO` carries only display and locale preferences, with no capability flags.
2. **Capability does not imply data.** A top-end watch still returns nothing for sleep on a night it was not worn, or for a feature enabled last week. Gating on hardware would hide working tools and keep non-working ones.
3. **It would make startup fragile and requests costlier.** Under `TRANSPORT=http` the server factory runs once per request, so a capability handshake inside it adds a Garmin round-trip to every request. Making tool registration depend on a network call also turns an expired key into a server that will not start, instead of a per-call error the model can report.

Grouping already keeps the manifest at ten tools, so gating would remove one or two at best.

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
