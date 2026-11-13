/** Women's health tool: menstrual cycle summary and detailed day view. */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { apiGet, type QueryValue } from "../api.js";
import {
  dateSchema,
  formatResult,
  includeEmptyFieldsSchema,
  responseFormatSchema,
  today,
  UNAVAILABLE_NOTE,
} from "../format.js";

export function registerWomensHealthTools(server: McpServer): void {
  server.registerTool(
    "garmin_get_menstrual_cycle",
    {
      title: "Get Menstrual Cycle Data",
      description: `Get menstrual cycle tracking data for a date.

view="summary" returns the cycle summary for the date, with cycle phase and prediction context. view="day_view" returns the detailed per-day log, which can include symptoms, flow, and pregnancy-mode baby movement (kick count) entries.

This data exists only when the user tracks cycles in Garmin Connect. An empty result means tracking is not enabled or no entry exists for that date, not a zero reading.`,
      inputSchema: z.strictObject({
        date: dateSchema.default(today())
          .describe("Calendar date to retrieve, YYYY-MM-DD. Defaults to today."),
        view: z.enum(["summary", "day_view"]).default("summary")
          .describe("'summary' for the cycle summary, 'day_view' for the detailed daily log"),
        today_date: dateSchema.optional()
          .describe("day_view only: the current date, used as the reference point for predictions. Defaults to today."),
        include_analysis: z.boolean().default(false)
          .describe("day_view only: include cycle analysis alongside the day's log"),
        include_baby_movement: z.boolean().default(true)
          .describe("day_view only: include baby movement (kick count) entries, used in pregnancy mode"),
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
      let path: string;
      const query: Record<string, QueryValue> = {};
      if (args.view === "summary") {
        path = `/periodichealth-service/menstrualcycle/summary/${args.date}`;
      } else {
        path = `/periodichealth-service/menstrualcycle/dayview/${args.date}`;
        query.todayDate = args.today_date ?? today();
        query.includeAnalysis = args.include_analysis;
        query.skipbm = !args.include_baby_movement;
      }

      const raw = await apiGet<Record<string, unknown>>(path, query, ctx.mcpReq.signal);
      if (!raw) {
        return {
          content: [
            {
              type: "text",
              text: `Garmin returned no menstrual cycle data for ${args.date}. ${UNAVAILABLE_NOTE}`,
            },
          ],
        };
      }
      return formatResult(
        args.response_format,
        `Menstrual cycle ${args.view} for ${args.date}`,
        { date: args.date, view: args.view, data: raw },
        { includeEmptyFields: args.include_empty_fields }
      );
    }
  );
}
