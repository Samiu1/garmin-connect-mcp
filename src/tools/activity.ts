/**
 * Activity tools: search, detail, wellness activities, and file download.
 *
 * `SummarizedActivityDTO` carries 230 properties, most of them specific to one
 * sport or sensor, so these tools default to a curated field set and offer
 * `detail_level="full"` for the complete payload.
 */
import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { apiGet, apiGetBinary, type QueryValue } from "../api.js";
import { CHARACTER_LIMIT } from "../constants.js";
import {
  dateSchema,
  formatResult,
  includeEmptyFieldsSchema,
  jsonResult,
  markdownResult,
  pruneEmpty,
  renderJsonAsMarkdown,
  responseFormatSchema,
  ResponseFormat,
  assertOrderedRange,
} from "../format.js";

/** Fields worth showing for every activity, whatever the sport. */
const ACTIVITY_SUMMARY_FIELDS = [
  "activityId",
  "activityName",
  "activityType",
  "eventType",
  "startTimeLocal",
  "distance",
  "duration",
  "elapsedDuration",
  "movingDuration",
  "calories",
  "averageHR",
  "maxHR",
  "averageSpeed",
  "maxSpeed",
  "elevationGain",
  "elevationLoss",
  "steps",
  "locationName",
  "aerobicTrainingEffect",
  "anaerobicTrainingEffect",
  "vO2MaxValue",
  "deviceId",
] as const;

/**
 * Fields worth showing from `summaryDTO`, whatever the sport.
 *
 * The detail endpoint names a few figures differently from the search endpoint:
 * aerobic training effect is `trainingEffect` here, and `steps`, `vO2MaxValue`
 * and `deviceId` are absent from this payload altogether.
 */
const ACTIVITY_DETAIL_SUMMARY_FIELDS = [
  "startTimeLocal",
  "distance",
  "duration",
  "movingDuration",
  "elapsedDuration",
  "calories",
  "averageHR",
  "maxHR",
  "averageSpeed",
  "maxSpeed",
  "elevationGain",
  "elevationLoss",
  "trainingEffect",
  "anaerobicTrainingEffect",
  "trainingEffectLabel",
] as const;

/** Top-level keys of the detail payload worth keeping alongside `summaryDTO`. */
const ACTIVITY_DETAIL_TOP_FIELDS = [
  "activityId",
  "activityName",
  "locationName",
  "activityTypeDTO",
  "eventTypeDTO",
] as const;

function typeKey(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const key = (value as { typeKey?: unknown }).typeKey;
    if (typeof key === "string") return key;
  }
  return undefined;
}

/** Formats seconds as h:mm:ss, the shape a human reads a workout in. */
function formatDuration(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** One line per activity, for list views. */
function formatActivityLine(activity: Record<string, unknown>): string {
  const parts: string[] = [];
  const name = activity.activityName ?? "(unnamed)";
  parts.push(`**${String(name)}** (ID ${String(activity.activityId)})`);

  const sport = typeKey(activity.activityType);
  if (sport) parts.push(sport);
  if (typeof activity.startTimeLocal === "string") parts.push(activity.startTimeLocal);
  if (typeof activity.distance === "number" && activity.distance > 0) {
    parts.push(`${(activity.distance / 1000).toFixed(2)} km`);
  }
  const duration = formatDuration(activity.duration);
  if (duration) parts.push(duration);
  if (typeof activity.averageHR === "number") parts.push(`avg HR ${Math.round(activity.averageHR)}`);
  if (typeof activity.calories === "number") parts.push(`${Math.round(activity.calories)} kcal`);
  return `- ${parts.join(" · ")}`;
}

function pickSummaryFields(activity: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of ACTIVITY_SUMMARY_FIELDS) {
    if (field in activity) picked[field] = activity[field];
  }
  return picked;
}

/**
 * Projects the detail endpoint's payload, whose shape differs from the search
 * endpoint's: every figure sits inside `summaryDTO` and the type objects carry a
 * `DTO` suffix, so `pickSummaryFields` matches only the activity id, name and
 * location here. Measured against a real run: 3 of its 22 fields.
 *
 * Garmin's own field names and nesting are preserved, so `response_format="json"`
 * still reports what Garmin sent. What is dropped is bulk the caller did not ask
 * for at this detail level: `metadataDTO`, `accessControlRuleDTO` and
 * `splitSummaries`.
 */
function pickDetailSummaryFields(
  activity: Record<string, unknown>
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of ACTIVITY_DETAIL_TOP_FIELDS) {
    if (field in activity) picked[field] = activity[field];
  }

  const summary = activity.summaryDTO;
  if (!summary || typeof summary !== "object") {
    // A payload without `summaryDTO` may be flat, as the search endpoint's is.
    // Fall back to that projection rather than returning identity fields alone.
    return { ...pickSummaryFields(activity), ...picked };
  }

  const source = summary as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of ACTIVITY_DETAIL_SUMMARY_FIELDS) {
    if (field in source) projected[field] = source[field];
  }
  if (Object.keys(projected).length > 0) picked.summaryDTO = projected;
  return picked;
}

export function registerActivityTools(server: McpServer): void {
  server.registerTool(
    "garmin_search_activities",
    {
      title: "Search Activities",
      description: `Search and filter the user's recorded Garmin activities (workouts), newest first by default.

Returns one page of compact activity summaries, each with an activity ID. Pass that ID to garmin_get_activity for full detail, or to garmin_download_activity_file for the original FIT/GPX file.

Examples:
  - "My runs last month" -> activity_type="running", start_date="2026-10-01", end_date="2026-10-31"
  - "Longest rides over 50km" -> activity_type="cycling", min_distance=50000, sort_by="distance", sort_order="desc"
  - "Find my race efforts" -> event_type="race"

Pagination: when has_more is true, call again with offset=next_offset.
This covers the common filters; garmin_get_raw reaches the dive-depth, bounding-box, and field-requirement filters.`,
      inputSchema: z.strictObject({
        offset: z.number().int().min(0).default(0)
          .describe("Number of activities to skip, for pagination"),
        limit: z.number().int().min(1).max(100).default(20)
          .describe("Maximum activities to return. Keep low; each activity is large."),
        start_date: dateSchema.optional()
          .describe("Earliest activity start date, inclusive, YYYY-MM-DD (local time)"),
        end_date: dateSchema.optional()
          .describe("Latest activity start date, inclusive, YYYY-MM-DD (local time)"),
        search: z.string().min(1).max(200).optional()
          .describe("Text to match in activity names and descriptions"),
        activity_type: z.string().optional()
          .describe("Parent activity type key, e.g. 'running', 'cycling', 'swimming'. Must be a parent type, not a subtype."),
        activity_sub_type: z.string().optional()
          .describe("Activity subtype key, e.g. 'trail_running'. Must belong to activity_type when both are given."),
        event_type: z.string().optional()
          .describe("Event classification: 'race', 'training', 'recreation', 'fitness', 'specialEvent', or 'uncategorized'"),
        min_distance: z.number().int().min(0).optional().describe("Minimum distance in meters, inclusive"),
        max_distance: z.number().int().min(0).optional().describe("Maximum distance in meters, inclusive"),
        min_duration: z.number().int().min(0).optional().describe("Minimum timer duration in seconds, inclusive"),
        max_duration: z.number().int().min(0).optional().describe("Maximum timer duration in seconds, inclusive"),
        min_elevation: z.number().int().min(0).optional().describe("Minimum total elevation gain in meters, inclusive"),
        max_elevation: z.number().int().min(0).optional().describe("Maximum total elevation gain in meters, inclusive"),
        min_avg_power: z.number().int().min(0).optional().describe("Minimum average power in watts, inclusive"),
        favorite: z.boolean().optional().describe("Restrict to favorites (true) or non-favorites (false). Omit for no filter."),
        exclude_children: z.boolean().default(true)
          .describe("Exclude child activities such as individual legs of a multisport activity"),
        sort_by: z.string().optional()
          .describe("Field to sort by, e.g. 'distance', 'duration', 'startLocal'. Defaults to start time."),
        sort_order: z.enum(["asc", "desc"]).default("desc").describe("Sort direction"),
        response_format: responseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      if (args.start_date && args.end_date) {
        assertOrderedRange(args.start_date, args.end_date);
      }
      const query: Record<string, QueryValue> = {
        start: args.offset,
        limit: args.limit,
        startDate: args.start_date,
        endDate: args.end_date,
        search: args.search,
        activityType: args.activity_type,
        activitySubType: args.activity_sub_type,
        eventType: args.event_type,
        minDistance: args.min_distance,
        maxDistance: args.max_distance,
        minDuration: args.min_duration,
        maxDuration: args.max_duration,
        minElevation: args.min_elevation,
        maxElevation: args.max_elevation,
        minAvgPower: args.min_avg_power,
        excludeChildren: args.exclude_children,
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
      };
      if (args.favorite !== undefined) query.favorite = args.favorite ? 1 : 0;

      const raw = await apiGet<Record<string, unknown>[]>(
        "/activitylist-service/activities/search/activities",
        query,
        ctx.mcpReq.signal
      );
      const activities = Array.isArray(raw) ? raw : [];

      // Garmin returns no total, so a full page implies at least one more page.
      const hasMore = activities.length === args.limit;
      const nextOffset = args.offset + activities.length;

      const render = (items: Record<string, unknown>[]) => {
        const page: Record<string, unknown> = {
          count: items.length,
          offset: args.offset,
          activities: items.map((item) => pruneEmpty(pickSummaryFields(item))),
          has_more: hasMore,
          ...(hasMore ? { next_offset: nextOffset } : {}),
        };
        if (args.response_format === ResponseFormat.JSON) {
          return { page, text: JSON.stringify(page, null, 2) };
        }
        const lines = [`Showing ${items.length} activities from offset ${args.offset}.`, ""];
        lines.push(items.map(formatActivityLine).join("\n"));
        if (hasMore) lines.push("", `More results: call again with offset=${nextOffset}.`);
        return { page, text: `# Activities\n\n${lines.join("\n")}` };
      };

      // Stay under the character limit by returning fewer activities, never by
      // cutting text, so next_offset still points at the first one left out.
      let items = activities;
      let result = render(items);
      while (items.length > 1 && result.text.length > CHARACTER_LIMIT) {
        items = items.slice(0, Math.ceil(items.length / 2));
        result = render(items);
      }

      if (items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No activities matched. Widen the date range or drop a filter. Note that activity_type must be a parent type such as 'running', not a subtype.",
            },
          ],
        };
      }
      if (args.response_format === ResponseFormat.JSON) {
        return {
          content: [{ type: "text", text: result.text }],
          structuredContent: result.page,
        };
      }
      return { content: [{ type: "text", text: result.text }] };
    }
  );

  server.registerTool(
    "garmin_get_activity",
    {
      title: "Get Activity Detail",
      description: `Get one activity in detail by its ID, optionally with its structured workout steps.

detail_level="summary" (the default) returns the sport-agnostic key fields: the activity's identity and type, plus the figures Garmin groups under summaryDTO -- distance, duration, calories, heart rate, speed, elevation and training effect. detail_level="full" returns all available fields, which for a single activity can exceed 200 properties covering dive, golf, and other sport-specific sensors.

Use garmin_search_activities to find activity IDs.`,
      inputSchema: z.strictObject({
        activity_id: z.number().int().positive().describe("Garmin activity ID, e.g. 123456789"),
        detail_level: z.enum(["summary", "full"]).default("summary")
          .describe("'summary' for sport-agnostic key fields, 'full' for every field Garmin returns"),
        include_workouts: z.boolean().default(false)
          .describe("Also fetch the activity's structured workout steps, when it followed a workout"),
        include_empty_fields: includeEmptyFieldsSchema,
        response_format: responseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      const [activity, workouts] = await Promise.all([
        apiGet<Record<string, unknown>>(
          `/activity-service/activity/${args.activity_id}`,
          {},
          ctx.mcpReq.signal
        ),
        args.include_workouts
          ? apiGet<unknown[]>(
              `/activity-service/activity/${args.activity_id}/workouts`,
              {},
              ctx.mcpReq.signal
            )
          : Promise.resolve(null),
      ]);

      if (!activity) {
        return {
          content: [
            {
              type: "text",
              text: `Garmin returned no activity ${args.activity_id}. Check the ID with garmin_search_activities.`,
            },
          ],
          isError: true,
        };
      }

      const payload: Record<string, unknown> = {
        activity_id: args.activity_id,
        activity:
          args.detail_level === "full"
            ? activity
            : pickDetailSummaryFields(activity),
      };
      if (args.include_workouts) {
        payload.workouts = workouts ?? [];
        if (!workouts || workouts.length === 0) {
          payload.workouts_note =
            "This activity has no structured workout attached.";
        }
      }

      return formatResult(
        args.response_format,
        `Activity ${args.activity_id}`,
        payload,
        { includeEmptyFields: args.include_empty_fields }
      );
    }
  );

  server.registerTool(
    "garmin_get_wellness_activities",
    {
      title: "Get Wellness Activities",
      description: `List automatically detected wellness activities over a date range: the low-effort movement Garmin logs without the user starting a workout, such as walks.

These are distinct from recorded workouts; use garmin_search_activities for those. Each entry includes the device that recorded it.`,
      inputSchema: z.strictObject({
        start_date: dateSchema.describe("First date in range, inclusive, YYYY-MM-DD"),
        end_date: dateSchema.describe("Last date in range, inclusive, YYYY-MM-DD"),
        include_empty_fields: includeEmptyFieldsSchema,
        response_format: responseFormatSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      assertOrderedRange(args.start_date, args.end_date);
      const raw = await apiGet<unknown[]>(
        `/wellnessactivity-service/activity/summary/range/${args.start_date}/${args.end_date}`,
        {},
        ctx.mcpReq.signal
      );
      const items = Array.isArray(raw) ? raw : [];
      if (items.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Garmin returned no wellness activities between ${args.start_date} and ${args.end_date}. The device may not log them, or none were detected.`,
            },
          ],
        };
      }
      return formatResult(
        args.response_format,
        `Wellness activities ${args.start_date} to ${args.end_date}`,
        { count: items.length, wellness_activities: items },
        { includeEmptyFields: args.include_empty_fields }
      );
    }
  );

  server.registerTool(
    "garmin_download_activity_file",
    {
      title: "Download Activity File",
      description: `Download an activity's original file from Garmin as a ZIP and save it to disk.

Garmin serves these as a ZIP archive containing the FIT file (and sometimes GPX/TCX). The ZIP is written to output_path and the tool reports the path and size; the file contents are not returned to the model.

Use garmin_search_activities to find activity IDs.`,
      inputSchema: z.strictObject({
        activity_id: z.number().int().positive().describe("Garmin activity ID, e.g. 123456789"),
        output_path: z.string().min(1)
          .describe("Absolute path to write the ZIP to, e.g. '/Users/me/Downloads/run.zip'"),
        overwrite: z.boolean().default(false)
          .describe("Replace output_path if a file is already there"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      if (!isAbsolute(args.output_path)) {
        return {
          content: [
            {
              type: "text",
              text: `output_path must be absolute; got '${args.output_path}'.`,
            },
          ],
          isError: true,
        };
      }
      const target = resolve(args.output_path);
      const bytes = await apiGetBinary(
        `/download-service/files/activity/${args.activity_id}`,
        ctx.mcpReq.signal
      );
      try {
        await writeFile(target, bytes, { flag: args.overwrite ? "w" : "wx" });
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "EEXIST") {
          return {
            content: [
              {
                type: "text",
                text: `${target} already exists. Pass overwrite=true to replace it, or choose another path.`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: `Saved activity ${args.activity_id} to ${target} (${bytes.byteLength} bytes, ZIP).`,
          },
        ],
      };
    }
  );
}
