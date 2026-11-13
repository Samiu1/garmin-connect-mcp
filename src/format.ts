/**
 * Shared input schemas and output rendering.
 *
 * The Personal API defines 109 response schemas, so rather than a hand-written
 * formatter per payload this module renders any JSON value as readable Markdown:
 * camelCase keys become Title Case, empty values are dropped, and nesting is
 * indented. Callers that need exact field names ask for `response_format="json"`.
 */
import * as z from "zod/v4";

import { CHARACTER_LIMIT } from "./constants.js";

export const ResponseFormat = {
  MARKDOWN: "markdown",
  JSON: "json",
} as const;

export type ResponseFormatValue =
  (typeof ResponseFormat)[keyof typeof ResponseFormat];

/** The `response_format` argument, shared by every data tool. */
export const responseFormatSchema = z
  .enum([ResponseFormat.MARKDOWN, ResponseFormat.JSON])
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "'markdown' for readable text, 'json' for the exact Garmin field names and values"
  );

/** A calendar date in the user's local time, as Garmin expects it. */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be in YYYY-MM-DD format");

/** Today's date in the host's local timezone, matching Garmin's calendar-date semantics. */
export function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Rejects a reversed range early, so the model gets a clear message instead of
 * Garmin's bare HTTP 400.
 */
export function assertOrderedRange(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new Error(
      `start_date (${startDate}) is after end_date (${endDate}). Swap them and retry.`
    );
  }
}

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Whether a value carries no information.
 *
 * Deliberately excludes `0` and `false`: zero steps, zero floors climbed, and a
 * false nap flag are real measurements from a working sensor, and dropping them
 * would be indistinguishable from the sensor being absent.
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Recursively removes empty values from a payload.
 *
 * Device capability varies across watch models, so a response routinely carries
 * large runs of nulls for sensors the user's hardware does not have. Pruning them
 * cuts response size substantially without losing any measurement. Absence is
 * reported separately, via the `metrics_unavailable` field on grouped tools, so a
 * pruned field is never mistaken for a zero reading.
 */
export function pruneEmpty<T>(value: T): T {
  if (Array.isArray(value)) {
    const items = value.map((item) => pruneEmpty(item)).filter((item) => !isEmpty(item));
    return items as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneEmpty(entryValue);
      if (!isEmpty(pruned)) result[key] = pruned;
    }
    return result as unknown as T;
  }
  return value;
}

/** Opt-out for callers that need to see which fields Garmin returned as null. */
export const includeEmptyFieldsSchema = z
  .boolean()
  .default(false)
  .describe(
    "Keep fields Garmin returned as null or empty. Off by default, since unsupported sensors " +
      "on the user's device produce large runs of nulls. Turn on only to inspect raw shape."
  );

function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    ["string", "number", "boolean", "undefined"].includes(typeof value)
  );
}

/** Renders any JSON value as indented Markdown bullets. */
export function renderJsonAsMarkdown(value: unknown, indent = ""): string {
  if (isEmpty(value)) return `${indent}_none_`;

  if (isPrimitive(value)) return `${indent}${String(value)}`;

  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) {
      return `${indent}${value.map((item) => String(item)).join(", ")}`;
    }
    return value
      .map((item, index) => {
        const body = renderJsonAsMarkdown(item, `${indent}  `);
        return `${indent}- [${index + 1}]\n${body}`;
      })
      .join("\n");
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entryValue]) => !isEmpty(entryValue)
  );
  if (entries.length === 0) return `${indent}_none_`;

  return entries
    .map(([key, entryValue]) => {
      const label = humanizeKey(key);
      if (isPrimitive(entryValue)) {
        return `${indent}- ${label}: ${String(entryValue)}`;
      }
      if (Array.isArray(entryValue) && entryValue.every(isPrimitive)) {
        return `${indent}- ${label}: ${entryValue.map(String).join(", ")}`;
      }
      return `${indent}- ${label}:\n${renderJsonAsMarkdown(entryValue, `${indent}  `)}`;
    })
    .join("\n");
}

/**
 * A tool result's content blocks, optionally with structured data.
 *
 * Declared as a type alias rather than an interface: the SDK's result type has an
 * `[x: string]: unknown` index signature, and only type aliases get TypeScript's
 * implicit index signature, so an interface here fails to type-check.
 */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Builds a Markdown result, noting when the payload had to be truncated. */
export function markdownResult(title: string, body: string): ToolResult {
  let text = `# ${title}\n\n${body}`;
  if (text.length > CHARACTER_LIMIT) {
    text =
      `${text.slice(0, CHARACTER_LIMIT - 200)}\n\n` +
      "_Output truncated at the character limit. Request a narrower date range, " +
      'fewer metrics, or use response_format="json" with a smaller range._';
  }
  return { content: [{ type: "text", text }] };
}

/**
 * Builds a JSON result. The payload is wrapped in an object so it always has a
 * `structuredContent`-compatible shape, even when Garmin returned an array.
 */
export function jsonResult(payload: Record<string, unknown>): ToolResult {
  let text = JSON.stringify(payload, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    // Compact first; drop to a pointer only if it is still too large.
    text = JSON.stringify(payload);
  }
  if (text.length > CHARACTER_LIMIT) {
    return {
      content: [
        {
          type: "text",
          text:
            `The JSON response is ${text.length} characters, over the ${CHARACTER_LIMIT} limit. ` +
            "Request a narrower date range or fewer metrics.",
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text", text }], structuredContent: payload };
}

/**
 * Returns a Markdown or JSON result according to `response_format`, pruning
 * empty values from both unless the caller asked to keep them.
 */
export function formatResult(
  format: ResponseFormatValue,
  title: string,
  payload: Record<string, unknown>,
  options: { includeEmptyFields?: boolean } = {}
): ToolResult {
  const data = options.includeEmptyFields ? payload : pruneEmpty(payload);
  if (format === ResponseFormat.JSON) return jsonResult(data);
  return markdownResult(title, renderJsonAsMarkdown(data));
}

/**
 * Splits requested metrics into those Garmin returned data for and those it did
 * not, so a tool result states unavailability instead of leaving the model to
 * infer it from a missing key.
 */
export function partitionAvailability(
  results: Record<string, unknown>,
  options: { prune?: boolean } = {}
): {
  data: Record<string, unknown>;
  metricsWithData: string[];
  metricsUnavailable: string[];
} {
  const prune = options.prune ?? true;
  const data: Record<string, unknown> = {};
  const metricsWithData: string[] = [];
  const metricsUnavailable: string[] = [];
  for (const [metric, value] of Object.entries(results)) {
    // Availability is always judged on the pruned value: a payload of nothing but
    // nulls means the sensor reported nothing, whatever the caller wants returned.
    const pruned = pruneEmpty(value);
    if (isEmpty(pruned)) {
      metricsUnavailable.push(metric);
    } else {
      metricsWithData.push(metric);
      data[metric] = prune ? pruned : value;
    }
  }
  return { data, metricsWithData, metricsUnavailable };
}

/** Explains an empty result in terms the model can repeat to the user. */
export const UNAVAILABLE_NOTE =
  "Garmin returned no data for these metrics on this date. That means the sensor is " +
  "absent from the device, the feature was not enabled, the device was not worn, or the " +
  "data has not synced — not that the measured value was zero.";
