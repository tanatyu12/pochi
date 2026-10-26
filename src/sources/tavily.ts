import { z } from "zod";
import type { QueryConfig, Sources } from "../config/schema.js";
import type { Item } from "../types.js";
import { itemId, normalizeUrl, parseHttpUrl } from "../util/hash.js";
import { HttpError, postJson } from "../util/http.js";
import { parseDate } from "../util/time.js";
import { plainTextToText, truncate } from "./html.js";
import { FeedParseError } from "./rss.js";

const SEARCH_URL = "https://api.tavily.com/search";
const TITLE_MAX_CHARS = 300;

const SearchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

type SearchResult = z.infer<typeof SearchSchema>["results"][number];

/** Without a key, queries are skipped rather than failed. */
export function tavilyApiKey(): string | undefined {
  return process.env.TAVILY_API_KEY?.trim() || undefined;
}

export async function fetchTavilyItems(
  query: QueryConfig,
  defaults: Sources["defaults"],
  signal?: AbortSignal,
): Promise<Item[]> {
  const key = tavilyApiKey();
  if (!key) return [];
  const body = {
    query: query.query,
    topic: query.topic,
    search_depth: "basic",
    // Replaces the deprecated `days`.
    time_range: "week",
    max_results: query.maxResults,
    include_answer: false,
    // The extracted snippet in `content` is enough; raw pages carry navigation and can be large.
    include_raw_content: false,
    include_images: false,
  };
  let text: string;
  try {
    // POST already skips 5xx retries (the search may have been billed); 429 is retried once.
    ({ text } = await postJson(SEARCH_URL, body, {
      signal,
      headers: { authorization: `Bearer ${key}` },
      retry: { rateLimit: 1 },
    }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      throw new HttpError("status", err.url, "Tavily rejected TAVILY_API_KEY (HTTP 401)", { status: 401, cause: err });
    }
    throw err;
  }
  return toTavilyItems(parseSearch(text).results, query, defaults);
}

function parseSearch(text: string): z.infer<typeof SearchSchema> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new FeedParseError(`not JSON: ${SEARCH_URL}`, { cause: err });
  }
  const parsed = SearchSchema.safeParse(json);
  if (!parsed.success) throw new FeedParseError(`unexpected Tavily response: ${SEARCH_URL}`, { cause: parsed.error });
  return parsed.data;
}

// Keeps Tavily's relevance order. The id leaves out the query, so the same page found by two
// queries is one item.
function toTavilyItems(results: SearchResult[], query: QueryConfig, defaults: Sources["defaults"]): Item[] {
  const seen = new Set<string>();
  return results.flatMap((r) => {
    const url = parseHttpUrl(r.url.trim())?.toString();
    if (!url) return [];
    const normalized = normalizeUrl(url) ?? url;
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    const title = truncate((r.title ?? "").replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS);
    return [
      {
        id: itemId("tavily", normalized),
        sourceId: query.id,
        // Queries have no name of their own.
        sourceName: query.query,
        kind: "tavily" as const,
        title: title || truncate(url, TITLE_MAX_CHARS),
        url,
        publishedAt: parseDate(r.published_date ?? undefined)?.toISOString(),
        content: plainTextToText(r.content ?? "", defaults.maxContentChars),
      },
    ];
  });
}
