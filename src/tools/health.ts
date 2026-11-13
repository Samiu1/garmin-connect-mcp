/**
 * Health tools: a one-day multi-metric snapshot, a single-metric trend over a
 * date range, and heart-rate zones.
 *
 * Which metrics exist depends on the device, on whether the feature was enabled,
 * and on whether the watch was worn that night. Rather than guessing from
 * hardware, these tools request what was asked for, then report exactly which
 * metrics came back with data and which did not.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { apiGet, type QueryValue } from "../api.js";
import {
  assertOrderedRange,
  dateSchema,
  detailLevelSchema,
  formatResult,
  includeEmptyFieldsSchema,
  jsonResult,
  markdownResult,
  partitionAvailability,
  projectPayload,
  renderJsonAsMarkdown,
  ResponseFormat,
  responseFormatSchema,
  today,
  UNAVAILABLE_NOTE,
} from "../format.js";

/** Metrics available for a single calendar date. */
const DAILY_METRICS = [
  "summary",
  "sleep",
  "heart_rate",
  "hrv",
  "spo2",
  "fitness_age",
  "nutrition",
] as const;

type DailyMetric = (typeof DAILY_METRICS)[number];

/** Metrics available as a series over a date range. */
const TREND_METRICS = [
  "steps",
  "stress",
  "hydration",
  "daily_summaries",
  "sleep",
  "hrv",
  "body_battery",
  "weight",
  "weight_all",
  "weight_goals",
] as const;

type TrendMetric = (typeof TREND_METRICS)[number];

/**
 * Longest range Garmin accepts per request, measured empirically — these limits
 * are not in the OpenAPI document and the API answers an over-long range with a
 * bare HTTP 400. Metrics absent from this map accepted a full year in testing.
 */
const MAX_RANGE_DAYS: Partial<Record<TrendMetric, number>> = {
  steps: 28,
  stress: 28,
  hydration: 31,
};

/** Rejects an over-long range locally, with the limit named. */
function assertWithinMetricLimit(
  metric: TrendMetric,
  startDate: string,
  endDate: string
): void {
  const max = MAX_RANGE_DAYS[metric];
  if (max === undefined) return;
  const days =
    Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
  if (days > max) {
    throw new Error(
      `Garmin accepts at most ${max} days per request for '${metric}', but ${startDate} to ${endDate} is ${days} days. ` +
        `Split it into ${Math.ceil(days / max)} calls of up to ${max} days each.`
    );
  }
}

interface Request {
  path: string;
  query: Record<string, QueryValue>;
}

/**
 * Explicit field lists for metrics whose bulk sits in nested objects rather than
 * in long arrays, so the generic summariser cannot shrink them enough.
 *
 * Sleep is the case that forced this: a night is ~3 KB, of which `sleepScores`,
 * `sleepNeed` and `sleepAlignment` are ~1.9 KB, while the stage totals a caller
 * asks for are a few hundred bytes. The dotted path keeps the one figure worth
 * having out of the bulky object.
 */
const SUMMARY_PATHS: Record<string, readonly string[]> = {
  // A month of these is 75 KB unprojected. Note that v2 groups figures into
  // nested category objects with their own names -- `bodyBattery.activityEvents`,
  // not `bodyBatteryActivityEventList` -- so the name-based omit list does not
  // reach them and explicit paths are required.
  daily_summaries: [
    "calendarDate",
    "movement.steps",
    "movement.floorsAscended",
    "calories.burnedTotal",
    "calories.burnedActive",
    "calories.burnedResting",
    "heartRate.restingValue",
    "heartRate.maxValue",
    "heartRate.minValue",
    "stress.avgLevel",
    "stress.maxLevel",
    "stress.qualifier",
    "bodyBattery.maxValue",
    "bodyBattery.minValue",
    "bodyBattery.chargedValue",
    "bodyBattery.drainedValue",
    "intensityMinutes.moderate",
    "intensityMinutes.vigorous",
    "intensityMinutes.goal",
    "pulseOx.avgValue",
    "pulseOx.minValue",
    "respiration.avgValue",
  ],
  sleep: [
    "calendarDate",
    "sleepStartTimestampLocal",
    "sleepEndTimestampLocal",
    "sleepTimeSeconds",
    "deepSleepSeconds",
    "lightSleepSeconds",
    "remSleepSeconds",
    "awakeSleepSeconds",
    "napTimeSeconds",
    "awakeCount",
    "avgHeartRate",
    "avgSleepStress",
    "averageRespirationValue",
    "averageSpO2Value",
    "lowestSpO2Value",
    "breathingDisruptionSeverity",
    "sleepScores.overall",
  ],
};

function dailyRequest(metric: DailyMetric, date: string): Request {
  switch (metric) {
    case "summary":
      return {
        path: "/usersummary-service/usersummary/daily",
        query: { calendarDate: date },
      };
    case "sleep":
      return { path: "/sleep-service/sleep/dailySleep", query: { date } };
    case "heart_rate":
      return { path: "/wellness-service/wellness/dailyHeartRate", query: { date } };
    case "hrv":
      return { path: `/hrv-service/hrv/${date}`, query: {} };
    case "spo2":
      return {
        path: `/wellness-service/wellness/daily/spo2acclimation/${date}`,
        query: {},
      };
    case "fitness_age":
      return {
        path: `/fitnessage-service/fitnessage/v2/${date}`,
        query: { fullHistoryScan: true },
      };
    case "nutrition":
      return {
        path: `/nutrition-service/food/logs/${date}`,
        query: { includeGoals: true, includeNutrition: true, includeMedia: false },
      };
  }
}

function trendRequest(
  metric: TrendMetric,
  startDate: string,
  endDate: string,
  options: { chunks?: number; includeAll: boolean }
): Request {
  switch (metric) {
    case "steps":
      return {
        path: `/usersummary-service/stats/steps/daily/${startDate}/${endDate}`,
        query: {},
      };
    case "stress":
      return {
        path: `/usersummary-service/stats/stress/daily/${startDate}/${endDate}`,
        query: {},
      };
    case "hydration":
      return {
        path: `/usersummary-service/stats/hydration/daily/${startDate}/${endDate}`,
        query: {},
      };
    case "daily_summaries":
      return {
        path: "/usersummary-service/v2/dailysummaries",
        query: { startDate, endDate },
      };
    case "sleep":
      return {
        path: "/sleep-service/sleep/dailySleepSummariesByDate",
        query: { startDate, endDate },
      };
    case "hrv":
      return { path: `/hrv-service/hrv/daily/${startDate}/${endDate}`, query: {} };
    case "body_battery":
      return {
        path: "/wellness-service/wellness/bodyBattery/reports/daily",
        query: { startDate, endDate, chunks: options.chunks },
      };
    case "weight":
      return {
        path: `/weight-service/weight/range/${startDate}/${endDate}`,
        query: { includeAll: options.includeAll },
      };
    case "weight_all":
      return {
        path: `/weight-service/weight/all/${startDate}/${endDate}`,
        query: {},
      };
    case "weight_goals":
      return {
        path: `/goal-service/goal/user/effective/weightgoal/${startDate}/${endDate}`,
        query: {},
      };
  }
}

export function registerHealthTools(server: McpServer): void {
  server.registerTool(
    "garmin_get_daily_health",
    {
      title: "Get Daily Health Snapshot",
      description: `Get several health metrics for a single calendar date in one call.

Requests each selected metric in parallel and reports which returned data. The result always lists metrics_unavailable: a metric appearing there means the sensor is absent from the device, the feature was off, the watch was not worn, or the data has not synced. It never means the measured value was zero.

Metrics: summary (steps, floors, calories, intensity minutes), sleep (stages and score), heart_rate (resting and daily range), hrv (overnight heart-rate variability), spo2 (pulse ox and acclimation), fitness_age, nutrition (logged food and goals).

Examples:
  - "How did I sleep last night?" -> date="2026-11-12", metrics=["sleep"]
  - "Full picture for yesterday" -> date="2026-11-12", metrics=["summary","sleep","heart_rate","hrv"]

For one metric across many days, use garmin_get_health_trend instead.`,
      inputSchema: z.strictObject({
        date: dateSchema.default(today())
          .describe("Calendar date in the user's local time, YYYY-MM-DD. Defaults to today."),
        metrics: z.array(z.enum(DAILY_METRICS)).min(1)
          .default(["summary", "sleep", "heart_rate", "hrv"])
          .describe("Which metrics to fetch. Request only what is needed; each adds to the response."),
        detail_level: detailLevelSchema,
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
      const unique = [...new Set(args.metrics)];

      // One failing metric must not fail the whole snapshot: a 403 on nutrition
      // should still let sleep and HRV through.
      const settled = await Promise.allSettled(
        unique.map((metric) => {
          const request = dailyRequest(metric, args.date);
          return apiGet(request.path, request.query, ctx.mcpReq.signal);
        })
      );

      const results: Record<string, unknown> = {};
      const errors: Record<string, string> = {};
      settled.forEach((outcome, index) => {
        const metric = unique[index];
        if (outcome.status === "fulfilled") {
          results[metric] = outcome.value;
        } else {
          errors[metric] = (outcome.reason as Error).message;
        }
      });

      const { data, metricsWithData, metricsUnavailable } = partitionAvailability(
        results,
        { prune: !args.include_empty_fields }
      );

      // Availability is judged on the raw payload above, then the projection is
      // applied. Doing it the other way round would report a metric as
      // unavailable when its only content was a series the summary omits.
      const projected: Record<string, unknown> = {};
      for (const [metric, value] of Object.entries(data)) {
        projected[metric] =
          args.detail_level === "full"
            ? value
            : projectPayload(value, SUMMARY_PATHS[metric]);
      }

      const payload: Record<string, unknown> = {
        date: args.date,
        metrics_with_data: metricsWithData,
        metrics_unavailable: metricsUnavailable,
        ...(metricsUnavailable.length > 0 ? { unavailable_note: UNAVAILABLE_NOTE } : {}),
        ...(Object.keys(errors).length > 0 ? { metric_errors: errors } : {}),
        detail_level: args.detail_level,
        data: projected,
      };

      // Not formatResult: `data` is already pruned, and the availability lists must
      // survive even when empty. Pruning the envelope would delete
      // `metrics_unavailable: []` exactly when every metric succeeded, which is the
      // case where a caller most needs to see that nothing was missing.
      if (args.response_format === ResponseFormat.JSON) {
        return jsonResult(payload);
      }

      const lines = [
        `With data: ${metricsWithData.join(", ") || "none"}`,
        `Unavailable: ${metricsUnavailable.join(", ") || "none"}`,
      ];
      if (metricsUnavailable.length > 0) lines.push("", UNAVAILABLE_NOTE);
      if (Object.keys(errors).length > 0) {
        lines.push("", "Errors:");
        for (const [metric, message] of Object.entries(errors)) {
          lines.push(`- ${metric}: ${message}`);
        }
      }
      lines.push("", renderJsonAsMarkdown(projected));

      return markdownResult(`Garmin health for ${args.date}`, lines.join("\n"));
    }
  );

  server.registerTool(
    "garmin_get_health_trend",
    {
      title: "Get Health Trend",
      description: `Get one health metric as a series across a date range, for trends and comparisons.

One metric per call keeps the response bounded. Metrics: steps, stress, hydration, daily_summaries (full daily wellness rollup), sleep (nightly summaries), hrv (daily HRV summaries), body_battery, weight (one entry per day), weight_all (every weigh-in), weight_goals.

Examples:
  - "Step trend this month" -> metric="steps", start_date="2026-11-01", end_date="2026-11-13"
  - "Has my sleep improved?" -> metric="sleep", start_date="2026-10-01", end_date="2026-11-13"
  - "All weigh-ins this year" -> metric="weight_all", start_date="2026-01-01", end_date="2026-11-13"

An empty result means no data in that range, not zero values. Narrow the range if the response hits the character limit.`,
      inputSchema: z.strictObject({
        metric: z.enum(TREND_METRICS).describe("Which single metric to fetch across the range"),
        start_date: dateSchema.describe("First date in range, inclusive, YYYY-MM-DD"),
        end_date: dateSchema.default(today())
          .describe("Last date in range, inclusive, YYYY-MM-DD. Defaults to today."),
        chunks: z.number().int().min(1).max(48).optional()
          .describe("body_battery only: intervals per day; each reports its lowest and highest reading"),
        include_all_weigh_ins: z.boolean().default(false)
          .describe("weight only: include every entry per day rather than the latest"),
        detail_level: detailLevelSchema,
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
      assertWithinMetricLimit(args.metric, args.start_date, args.end_date);
      const request = trendRequest(args.metric, args.start_date, args.end_date, {
        chunks: args.chunks,
        includeAll: args.include_all_weigh_ins,
      });
      const raw = await apiGet(request.path, request.query, ctx.mcpReq.signal);

      if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
        return {
          content: [
            {
              type: "text",
              text:
                `Garmin returned no ${args.metric} data between ${args.start_date} and ${args.end_date}. ` +
                UNAVAILABLE_NOTE,
            },
          ],
        };
      }

      const payload: Record<string, unknown> = {
        metric: args.metric,
        start_date: args.start_date,
        end_date: args.end_date,
        ...(Array.isArray(raw) ? { count: raw.length } : {}),
        detail_level: args.detail_level,
        data:
          args.detail_level === "full"
            ? raw
            : projectPayload(raw, SUMMARY_PATHS[args.metric]),
      };

      return formatResult(
        args.response_format,
        `${args.metric} from ${args.start_date} to ${args.end_date}`,
        payload,
        { includeEmptyFields: args.include_empty_fields }
      );
    }
  );

  server.registerTool(
    "garmin_get_heart_rate_zones",
    {
      title: "Get Heart Rate Zones",
      description:
        "Get the user's configured heart-rate training zones, including the boundary beats per minute for each zone. Useful for interpreting the averageHR and maxHR on activities.",
      inputSchema: z.strictObject({
        generate_defaults: z.boolean().default(true)
          .describe("Return Garmin's default zones when the user has configured none"),
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
      const raw = await apiGet<unknown[]>(
        "/biometric-service/heartRateZones/v2",
        { generateDefaults: args.generate_defaults },
        ctx.mcpReq.signal
      );
      const zones = Array.isArray(raw) ? raw : [];
      if (zones.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Garmin returned no heart-rate zones. Try generate_defaults=true.",
            },
          ],
        };
      }
      return formatResult(
        args.response_format,
        "Heart rate zones",
        { count: zones.length, zones },
        { includeEmptyFields: args.include_empty_fields }
      );
    }
  );
}
