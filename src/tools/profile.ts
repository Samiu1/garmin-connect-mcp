/** User profile tool: units and locale settings needed to interpret other data. */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { apiGet } from "../api.js";
import {
  formatResult,
  includeEmptyFieldsSchema,
  responseFormatSchema,
} from "../format.js";

export function registerProfileTools(server: McpServer): void {
  server.registerTool(
    "garmin_get_user_profile",
    {
      title: "Get User Profile Settings",
      description: `Get the user's Garmin Connect profile settings: display name, locale, time zone, and the unit preferences that other responses are expressed in.

Call this first when units matter. measurementSystem tells you whether the user thinks in metric or statute, and powerFormat, heartRateFormat, hydrationMeasurementUnit, and glucoseMeasurementUnit give the per-metric display units. Garmin returns distances in meters and durations in seconds regardless, so this is about how to present them.

Note: this endpoint carries no device or sensor information. The Personal API exposes no device inventory, so which metrics a user has is discovered by requesting them; garmin_get_daily_health reports what came back.`,
      inputSchema: z.strictObject({
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
      const settings = await apiGet<Record<string, unknown>>(
        "/userprofile-service/userprofile/settings",
        {},
        ctx.mcpReq.signal
      );
      if (!settings) {
        return {
          content: [
            {
              type: "text",
              text: "Garmin returned no profile settings. The Personal API key may not cover profile data.",
            },
          ],
          isError: true,
        };
      }
      return formatResult(
        args.response_format,
        "Garmin user profile settings",
        settings,
        { includeEmptyFields: args.include_empty_fields }
      );
    }
  );
}
