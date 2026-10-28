import { z } from "zod";
import type { QueryConfig } from "../config/schema.js";
import type { FetchDefaults, Item } from "../types.js";
import { itemId, normalizeUrl, parseHttpUrl, urlKey } from "../util/hash.js";
import { HttpError, postJson } from "../util/http.js";
import { parseDate, toIsoDate } from "../util/time.js";
import { parseApi } from "./api.js";
import { collapseWhitespace, truncate } from "../util/text.js";
import { plainTextToText } from "./html.js";

const SEARCH_URL = "https://api.tavily.com/search";
const TITLE_MAX_CHARS = 300;

const SearchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      // A result without a URL is skipped, not a reason to lose the others.
      url: z.string().nullish(),
      content: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

type SearchResult = z.infer<typeof SearchSchema>["results"][number];

/** Without a key, queries are skipped rather than failed. */
export function tavilyApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.TAVILY_API_KEY?.trim() || undefined;
}

export async function fetchTavilyItems(
  query: QueryConfig,
  defaults: FetchDefaults,
  signal?: AbortSignal,
): Promise<Item[]> {
  const key = tavilyApiKey();
  if (!key) return [];
  const body = {
    query: query.query,
    topic: query.topic,
    search_depth: "basic",
    // From the last run, so a daily run is not handed the same week's top results again and a
    // weekly one misses nothing; the first run looks back a week. Replaces the deprecated `days`.
    ...(defaults.since ? { start_date: toIsoDate(defaults.since) } : { time_range: "week" }),
    // Only news results carry a date otherwise, and an undated result passes the maxItemAgeDays check.
    include_published_date: true,
    // Also drops results without a detectable date, which the window alone keeps.
    ...(query.requireDate && { filter_by_published_date: true }),
    max_results: query.maxResults,
    include_answer: false,
    // The extracted snippet in `content` is enough; raw pages carry navigation and can be large.
    include_raw_content: false,
    include_images: false,
  };
  let text: string;
  try {
    // By default a POST is not retried on 5xx (the search may have been billed) and a 429 is retried once.
    ({ text } = await postJson(SEARCH_URL, body, { signal, headers: { authorization: `Bearer ${key}` } }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      throw new HttpError("status", err.url, "Tavily rejected TAVILY_API_KEY (HTTP 401)", { status: 401, cause: err });
    }
    throw err;
  }
  return toTavilyItems(parseApi(text, SearchSchema, SEARCH_URL, "Tavily").results, query, defaults);
}

// Keeps Tavily's relevance order. The id leaves out the query, so the same page found by two
// queries is one item.
function toTavilyItems(results: SearchResult[], query: QueryConfig, defaults: FetchDefaults): Item[] {
  const seen = new Set<string>();
  return results.flatMap((r) => {
    const url = r.url ? parseHttpUrl(r.url.trim())?.toString() : undefined;
    if (!url) return [];
    const normalized = normalizeUrl(url) ?? url;
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    const title = truncate(collapseWhitespace(r.title ?? ""), TITLE_MAX_CHARS);
    return [
      {
        id: itemId("tavily", normalized),
        sourceId: query.id,
        // Queries have no name of their own.
        sourceName: query.query,
        kind: "tavily" as const,
        title: title || truncate(url, TITLE_MAX_CHARS),
        url,
        urlKey: urlKey(normalized),
        publishedAt: parseDate(r.published_date ?? undefined)?.toISOString(),
        content: plainTextToText(r.content ?? "", defaults.maxContentChars),
      },
    ];
  });
}
