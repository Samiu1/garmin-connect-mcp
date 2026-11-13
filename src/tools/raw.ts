/**
 * Escape hatch for Personal API endpoints the grouped tools do not wrap, and for
 * query parameters they leave out.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { apiGet, type QueryValue } from "../api.js";
import {
  formatResult,
  includeEmptyFieldsSchema,
  responseFormatSchema,
} from "../format.js";

/** Keeps the request on the configured Garmin host and inside its path space. */
function validatePath(path: string): string | undefined {
  if (!path.startsWith("/")) return "path must start with '/'";
  if (path.startsWith("//")) return "path must not start with '//'";
  if (path.includes("://")) return "path must be a path, not a full URL";
  if (path.includes("..")) return "path must not contain '..'";
  if (/[\s\r\n]/.test(path)) return "path must not contain whitespace";
  return undefined;
}

export function registerRawTools(server: McpServer): void {
  server.registerTool(
    "garmin_get_raw",
    {
      title: "Call a Garmin Endpoint Directly",
      description: `Perform an authenticated GET against any Garmin Personal API path, for endpoints and parameters the other tools do not expose.

The request goes to the configured Garmin host with the bearer token applied; only the path and query are yours to set.

Use it for:
  - Activity search filters the dedicated tool omits: upperLatitude/leftLongitude/lowerLatitude/rightLongitude bounding boxes, lowerMaxDepth/upperMaxDepth and decoDive for diving, minBottomTime/maxBottomTime, minElapsedDuration/maxElapsedDuration, excludedActivitySubType, requiredField
  - Any endpoint Garmin adds after this server was written

Example: path="/activitylist-service/activities/search/activities", query={"activityType":"diving","lowerMaxDepth":"1800","limit":"5"}

Prefer the dedicated tools when one covers the request: they format results and report metric availability.`,
      inputSchema: z.strictObject({
        path: z.string().min(1)
          .describe("Endpoint path beginning with '/', e.g. '/userprofile-service/userprofile/settings'"),
        query: z.record(z.string(), z.string()).optional()
          .describe("Query parameters as string key/value pairs. Repeatable parameters take a comma-separated value."),
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
      const problem = validatePath(args.path);
      if (problem) {
        return {
          content: [{ type: "text", text: `Invalid path: ${problem}. Got '${args.path}'.` }],
          isError: true,
        };
      }

      const query: Record<string, QueryValue> = {};
      for (const [key, value] of Object.entries(args.query ?? {})) {
        query[key] = value.includes(",") ? value.split(",").map((part) => part.trim()) : value;
      }

      const raw = await apiGet(args.path, query, ctx.mcpReq.signal);
      if (raw === null) {
        return {
          content: [
            {
              type: "text",
              text: `Garmin returned no content (HTTP 204) for ${args.path}. The endpoint is valid but has no data for these parameters.`,
            },
          ],
        };
      }
      return formatResult(
        args.response_format,
        `GET ${args.path}`,
        { path: args.path, data: raw },
        { includeEmptyFields: args.include_empty_fields }
      );
    }
  );
}
