import type { z } from "zod";
import { FeedParseError } from "./rss.js";

/** Parses a JSON API response against `schema`. Throws FeedParseError if it is not JSON or has another shape. */
export function parseApi<T>(text: string, schema: z.ZodType<T>, url: string, service: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new FeedParseError(`not JSON: ${url}`, { cause: err });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new FeedParseError(`unexpected ${service} response: ${url}`, { cause: parsed.error });
  return parsed.data;
}
