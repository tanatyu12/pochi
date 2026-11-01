import type { SourcesInput } from "../../config/schema.js";
import { normalizeUrl } from "../../util/hash.js";
import { collapseWhitespace, stripControlChars } from "../../util/text.js";

export type FeedInput = NonNullable<SourcesInput["feeds"]>[number];
export type QueryInput = NonNullable<SourcesInput["queries"]>[number];
export type QuerySuggestion = {
  query: string;
  topic: NonNullable<QueryInput["topic"]>;
  hint?: string;
  includeDomains?: string[];
  /** From the proposal or an idea the user picked, so picked to begin with when it is free. */
  proposed?: boolean;
};

// GitHub treats owner/repo case-insensitively; feed URLs compare as the pipeline dedupes them. A
// news search and a web search for the same words are different sources.
export function keyOf(source: FeedInput | QueryInput): string {
  if (!("type" in source)) return queryKey(source.query);
  switch (source.type) {
    case "github":
      return repoKey(source.repo);
    case "googlenews":
      return newsKey(source.query, source.sites);
    case "rss":
      return feedKey(source.url);
  }
}

export function newsKey(query: string, sites: readonly string[] = []): string {
  return `news:${cleanQuery(query).toLowerCase()}|${[...sites].sort().join(",")}`;
}

export function repoKey(repo: string): string {
  return `github:${repo.toLowerCase()}`;
}

export function feedKey(url: string): string {
  return `rss:${normalizeUrl(url)}`;
}

export function queryKey(query: string): string {
  return `query:${cleanQuery(query).toLowerCase()}`;
}

/** What a source is called on screen; a news search may have no name of its own. */
export function labelOf(feed: FeedInput): string {
  return feed.type === "googlenews" ? (feed.name ?? feed.query) : feed.name;
}

// What is stored and searched for; shortening for the screen is left to displayLine.
export function cleanQuery(query: string): string {
  return collapseWhitespace(stripControlChars(query));
}

/** Cleans each query, dropping the ones that clean to nothing and repeats in any case. */
export function cleanSuggestions(suggestions: QuerySuggestion[]): QuerySuggestion[] {
  const seen = new Set<string>();
  return suggestions
    .map((q) => ({ ...q, query: cleanQuery(q.query) }))
    .filter((q) => q.query !== "" && once(seen, q.query.toLowerCase()));
}

/** True the first time key is seen. */
export function once(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}
