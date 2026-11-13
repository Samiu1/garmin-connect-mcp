#!/usr/bin/env node
/**
 * MCP server for the Garmin Connect Personal API.
 *
 * Each user supplies their own Personal API key, created at
 * https://connect.garmin.com/app/settings/personalApiToken. The key is exchanged
 * for a short-lived bearer token on demand; see src/auth.ts.
 *
 * Serves stdio only: the host launches it as a subprocess. A Streamable HTTP
 * transport is intentionally not shipped, because the SDK handler verifies no
 * tokens and this server reads a person's full health history — it would need
 * authentication in front of the route before being reachable off-device.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { baseUrl, resolveApiKey } from "./auth.js";
import { GarminConfigError } from "./errors.js";
import { registerActivityTools } from "./tools/activity.js";
import { registerHealthTools } from "./tools/health.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerRawTools } from "./tools/raw.js";
import { registerWomensHealthTools } from "./tools/womens-health.js";

const SERVER_NAME = "garmin-connect-mcp";
const SERVER_VERSION = "1.0.0";

/**
 * Guidance for clients that surface server instructions. The same facts are
 * repeated in tool descriptions and in the responses themselves, because many
 * clients drop this field.
 */
const INSTRUCTIONS = `This server reads one person's own Garmin Connect data through the Personal API. Everything is read-only except garmin_download_activity_file, which writes a ZIP to a path you give it.

Interpreting results:
- A metric listed in metrics_unavailable, or an empty result, means Garmin returned no data: the sensor is absent from that device, the feature was not enabled, the watch was not worn, or the data has not synced. Say the data is unavailable. Never report it as zero, and never estimate it.
- Garmin returns distances in meters and durations in seconds. Call garmin_get_user_profile to learn whether the user thinks in metric or statute units before presenting figures.
- Dates are calendar dates in the user's local time zone, formatted YYYY-MM-DD.
- The Personal API exposes no device inventory, so there is no way to list the user's watches or ask what sensors they have. Determine availability by requesting a metric and reading what comes back.

Choosing a tool:
- One date, several metrics -> garmin_get_daily_health
- One metric, a date range -> garmin_get_health_trend
- Finding workouts -> garmin_search_activities, then garmin_get_activity with the ID
- Anything not covered -> garmin_get_raw`;

/**
 * Builds a fresh server with every tool registered.
 *
 * serveStdio calls this once per connection. It stays cheap and holds no
 * cross-connection state; the API client and token cache live at module scope in
 * api.ts and auth.ts.
 */
function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );

  registerActivityTools(server);
  registerHealthTools(server);
  registerProfileTools(server);
  registerWomensHealthTools(server);
  registerRawTools(server);

  return server;
}

// Fail fast on a missing key: a clear message at startup beats the same error on
// every tool call. This reads local configuration only and makes no network call.
try {
  resolveApiKey();
} catch (error) {
  if (error instanceof GarminConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

serveStdio(createServer);
// stderr only: stdout carries the JSON-RPC stream.
console.error(`${SERVER_NAME} running on stdio (Garmin host: ${baseUrl()})`);
