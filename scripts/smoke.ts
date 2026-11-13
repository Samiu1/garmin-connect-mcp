/**
 * Self-check: starts the built server over stdio, calls its tools as a client
 * would, and exits non-zero on any failure.
 *
 * Run with: npm run build && npm run smoke
 *
 * Works without credentials: it uses a placeholder key to verify the tool
 * manifest, argument validation, and error messages. When GARMIN_PERSONAL_API_KEY
 * holds a real key, it additionally calls read-only tools against Garmin.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const EXPECTED_TOOLS = [
  "garmin_download_activity_file",
  "garmin_get_activity",
  "garmin_get_daily_health",
  "garmin_get_health_trend",
  "garmin_get_heart_rate_zones",
  "garmin_get_menstrual_cycle",
  "garmin_get_raw",
  "garmin_get_user_profile",
  "garmin_get_wellness_activities",
  "garmin_search_activities",
];

/**
 * Decides whether to run live, matching the key sources the server itself uses.
 *
 * When the key is only in the default key file, nothing is passed in the child's
 * environment: the server resolves it from disk, which exercises that path too.
 */
function selectKeySource(): {
  live: boolean;
  childEnv: Record<string, string>;
  how: string;
} {
  const fromEnv = process.env.GARMIN_PERSONAL_API_KEY?.trim();
  if (fromEnv) {
    return {
      live: true,
      childEnv: { GARMIN_PERSONAL_API_KEY: fromEnv },
      how: "GARMIN_PERSONAL_API_KEY",
    };
  }

  // Not a secret itself, so it is safe to pass through and to print.
  const command = process.env.GARMIN_PERSONAL_API_KEY_COMMAND?.trim();
  if (command) {
    return {
      live: true,
      childEnv: { GARMIN_PERSONAL_API_KEY_COMMAND: command },
      how: `key command: ${command}`,
    };
  }

  const keyFile = join(homedir(), ".config/garmin/connect-personal-api-key");
  try {
    if (readFileSync(keyFile, "utf8").trim()) {
      // Pass nothing: the server resolves the file itself, exercising that path.
      return { live: true, childEnv: {}, how: `key file ${keyFile}` };
    }
  } catch {
    // No key file; fall through to the offline run.
  }

  return {
    live: false,
    childEnv: { GARMIN_PERSONAL_API_KEY: "placeholder-key-for-offline-smoke-test" },
    how: "placeholder (offline)",
  };
}

const { live, childEnv, how } = selectKeySource();
console.error(`Credential source: ${how}`);

function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as { type: string; text?: string }[];
  return blocks.map((block) => block.text ?? "").join("\n");
}

const client = new Client({ name: "garmin-smoke-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    // The child gets only a safe default environment (PATH, HOME and similar), so
    // pass the chosen credential source explicitly. When the key lives in the
    // default key file, nothing is passed and HOME is enough to find it.
    env: { ...getDefaultEnvironment(), ...childEnv },
  })
);

// ---- Manifest ----

const { tools } = await client.listTools();
assert.deepEqual(
  tools.map((tool) => tool.name).sort(),
  EXPECTED_TOOLS,
  "the advertised tool list changed"
);

for (const tool of tools) {
  assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
  assert.ok(tool.annotations, `${tool.name} is missing annotations`);
}

const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
assert.equal(readOnly.length, 9, "nine tools should be read-only; only the file download writes");

const download = tools.find((tool) => tool.name === "garmin_download_activity_file");
assert.equal(download?.annotations?.readOnlyHint, false, "the download tool writes a file");

// `.describe()` text must survive into the advertised schema, or the model gets
// no documentation for any argument.
const trend = tools.find((tool) => tool.name === "garmin_get_health_trend");
const trendProps = (trend?.inputSchema as { properties?: Record<string, { description?: string }> })
  .properties;
assert.ok(trendProps?.metric?.description, "garmin_get_health_trend.metric lost its description");
assert.ok(trendProps?.detail_level?.description, "garmin_get_health_trend must offer detail_level");

const daily = tools.find((tool) => tool.name === "garmin_get_daily_health");
const dailyProps = (daily?.inputSchema as { properties?: Record<string, unknown> }).properties;
assert.ok(dailyProps?.detail_level, "garmin_get_daily_health must offer detail_level");

// ---- Argument validation (no network required) ----

const badDate = await client.callTool({
  name: "garmin_get_daily_health",
  arguments: { date: "13-11-2026" },
});
assert.equal(badDate.isError, true, "a non-ISO date should be rejected");

const reversed = await client.callTool({
  name: "garmin_get_health_trend",
  arguments: { metric: "steps", start_date: "2026-11-13", end_date: "2026-11-01" },
});
assert.equal(reversed.isError, true, "a reversed date range should be rejected");
assert.match(textOf(reversed), /after end_date/, "the range error should name the problem");

const unknownArg = await client.callTool({
  name: "garmin_get_heart_rate_zones",
  arguments: { not_a_real_argument: true },
});
assert.equal(unknownArg.isError, true, "strict schemas should reject unknown arguments");

const absoluteUrl = await client.callTool({
  name: "garmin_get_raw",
  arguments: { path: "https://example.com/steal" },
});
assert.equal(absoluteUrl.isError, true, "garmin_get_raw must reject a full URL");
assert.match(textOf(absoluteUrl), /Invalid path/, "the path error should explain why");

// A protocol-relative path would resolve to another host, so it must be refused
// even though it does start with a slash.
const protocolRelative = await client.callTool({
  name: "garmin_get_raw",
  arguments: { path: "//example.com/steal" },
});
assert.equal(protocolRelative.isError, true, "garmin_get_raw must reject a protocol-relative path");
assert.match(textOf(protocolRelative), /must not start with '\/\/'/, "the error should name the cause");

const embeddedScheme = await client.callTool({
  name: "garmin_get_raw",
  arguments: { path: "/redirect?to=https://example.com" },
});
assert.equal(embeddedScheme.isError, true, "a path carrying a URL scheme must be refused");

const traversal = await client.callTool({
  name: "garmin_get_raw",
  arguments: { path: "/foo/../../bar" },
});
assert.equal(traversal.isError, true, "garmin_get_raw must reject path traversal");

const relativePath = await client.callTool({
  name: "garmin_download_activity_file",
  arguments: { activity_id: 1, output_path: "run.zip" },
});
assert.equal(relativePath.isError, true, "a relative output_path should be rejected");

// ---- Key-command source ----

// Proves the GARMIN_PERSONAL_API_KEY_COMMAND path end to end without needing a
// keychain entry: the command resolves, and the key it printed is what reaches
// Garmin's token endpoint.
const commandClient = new Client({ name: "garmin-smoke-key-command", version: "1.0.0" });
await commandClient.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...getDefaultEnvironment(),
      GARMIN_PERSONAL_API_KEY_COMMAND: "printf %s not-a-real-key-from-command",
    },
  })
);
const commandTools = await commandClient.listTools();
assert.equal(
  commandTools.tools.length,
  EXPECTED_TOOLS.length,
  "a key command should start the server like any other source"
);
const commandCall = await commandClient.callTool({
  name: "garmin_get_user_profile",
  arguments: {},
});
assert.equal(commandCall.isError, true, "a bogus key from the command should fail at the exchange");
assert.doesNotMatch(
  textOf(commandCall),
  /produced no output|_COMMAND failed/,
  "the command itself should have succeeded; only the exchange should fail"
);
await commandClient.close();

// Both failure modes must stop startup with an explanation, not start a server
// that fails on every call.
const noKeyEnv = { ...process.env, GARMIN_PERSONAL_API_KEY: "" };

const emptyOutput = spawnSync("node", ["dist/index.js"], {
  encoding: "utf8",
  timeout: 20_000,
  env: { ...noKeyEnv, GARMIN_PERSONAL_API_KEY_COMMAND: "true" },
});
assert.equal(emptyOutput.status, 1, "a key command printing nothing should exit 1");
assert.match(emptyOutput.stderr, /produced no output/, "and should say the output was empty");

const failingCommand = spawnSync("node", ["dist/index.js"], {
  encoding: "utf8",
  timeout: 20_000,
  env: { ...noKeyEnv, GARMIN_PERSONAL_API_KEY_COMMAND: "exit 7" },
});
assert.equal(failingCommand.status, 1, "a failing key command should exit 1");
assert.match(failingCommand.stderr, /_COMMAND failed/, "and should name the command as the cause");

// ---- Live calls ----

if (!live) {
  // A placeholder key must fail at the token exchange with a message that says
  // what to do, not with an unhandled crash.
  const rejected = await client.callTool({
    name: "garmin_get_user_profile",
    arguments: {},
  });
  assert.equal(rejected.isError, true, "a placeholder key should not authenticate");
  assert.match(
    textOf(rejected),
    /Personal API key|HTTP 40/,
    "the auth failure should name the key as the cause"
  );
  console.error(
    "Smoke test passed (offline). To also exercise live calls, set GARMIN_PERSONAL_API_KEY " +
      "or save your key in ~/.config/garmin/connect-personal-api-key."
  );
} else {
  const profile = await client.callTool({
    name: "garmin_get_user_profile",
    arguments: { response_format: "json" },
  });
  assert.ok(!profile.isError, `garmin_get_user_profile failed: ${textOf(profile)}`);
  assert.ok(
    (profile.structuredContent as Record<string, unknown> | undefined) !== undefined,
    "JSON mode should return structuredContent"
  );

  const daily = await client.callTool({
    name: "garmin_get_daily_health",
    arguments: { metrics: ["summary", "sleep"], response_format: "json" },
  });
  assert.ok(!daily.isError, `garmin_get_daily_health failed: ${textOf(daily)}`);
  const snapshot = daily.structuredContent as {
    metrics_with_data?: string[];
    metrics_unavailable?: string[];
  };
  assert.ok(
    Array.isArray(snapshot.metrics_with_data) && Array.isArray(snapshot.metrics_unavailable),
    "the snapshot must always report metric availability"
  );

  const activities = await client.callTool({
    name: "garmin_search_activities",
    arguments: { limit: 3, response_format: "json" },
  });
  assert.ok(!activities.isError, `garmin_search_activities failed: ${textOf(activities)}`);

  const zones = await client.callTool({ name: "garmin_get_heart_rate_zones", arguments: {} });
  assert.ok(!zones.isError, `garmin_get_heart_rate_zones failed: ${textOf(zones)}`);

  // A month of sleep must fit. Before per-metric projections this was 91 KB and
  // came back as an over-limit error, which made an ordinary question unanswerable.
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

  for (const metric of ["sleep", "daily_summaries", "body_battery"]) {
    const month = await client.callTool({
      name: "garmin_get_health_trend",
      arguments: { metric, start_date: monthAgo, end_date: yesterday, response_format: "json" },
    });
    assert.ok(!month.isError, `a month of ${metric} should fit in summary mode: ${textOf(month)}`);
  }

  // Summary mode must actually be smaller, or the projection is not doing its job.
  const asFull = await client.callTool({
    name: "garmin_get_daily_health",
    arguments: { date: yesterday, metrics: ["heart_rate"], detail_level: "full", response_format: "json" },
  });
  const asSummary = await client.callTool({
    name: "garmin_get_daily_health",
    arguments: { date: yesterday, metrics: ["heart_rate"], detail_level: "summary", response_format: "json" },
  });
  assert.ok(
    textOf(asSummary).length * 4 < textOf(asFull).length,
    `summary should be far smaller than full: ${textOf(asSummary).length} vs ${textOf(asFull).length}`
  );

  // Garmin caps steps and stress at 28 days with a bare HTTP 400; the server must
  // refuse locally and name the limit instead of passing that through.
  const tooLong = await client.callTool({
    name: "garmin_get_health_trend",
    arguments: { metric: "steps", start_date: monthAgo, end_date: yesterday },
  });
  assert.equal(tooLong.isError, true, "a 30-day steps range should be refused locally");
  assert.match(textOf(tooLong), /at most 28 days/, "the refusal should name Garmin's limit");

  const atLimit = await client.callTool({
    name: "garmin_get_health_trend",
    arguments: {
      metric: "steps",
      start_date: new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10),
      end_date: yesterday,
      response_format: "json",
    },
  });
  assert.ok(!atLimit.isError, `28 days of steps is within the limit: ${textOf(atLimit)}`);

  console.error("Smoke test passed (live against Garmin).");
}

await client.close();
