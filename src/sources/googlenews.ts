import type { GoogleNewsFeed } from "../config/schema.js";
import type { FetchDefaults, Item } from "../types.js";
import { toIsoDate } from "../util/time.js";
import { fetchFeedItems } from "./rss.js";

const SEARCH_URL = "https://news.google.com/rss/search";

/** Shown in briefings and logs: the name, or the query when there is none. */
export function googleNewsName(feed: GoogleNewsFeed): string {
  return feed.name ?? feed.query;
}

/**
 * The search as a Google News RSS URL. Free and keyless, unlike a Tavily query; the time range
 * starts at since, as Tavily's start_date does, so a daily run is not handed the same week again.
 */
export function googleNewsUrl(feed: GoogleNewsFeed, since?: Date): string {
  const sites = feed.sites ?? [];
  const site =
    sites.length === 0 ? "" : sites.length === 1 ? ` site:${sites[0]}` : ` (${sites.map((s) => `site:${s}`).join(" OR ")})`;
  const range = since ? ` after:${toIsoDate(since)}` : " when:7d";
  const [language, region] = feed.locale.split("-") as [string, string];
  const params = new URLSearchParams({ q: `${feed.query}${site}${range}`, hl: language, gl: region, ceid: `${region}:${language}` });
  return `${SEARCH_URL}?${params}`;
}

// The newest first, as with any feed: Google News sorts by date, not by how well an article matches.
export function fetchGoogleNewsItems(
  feed: GoogleNewsFeed,
  defaults: FetchDefaults,
  signal?: AbortSignal,
): Promise<Item[]> {
  const source = { id: feed.id, name: googleNewsName(feed), kind: "googlenews" as const };
  return fetchFeedItems(googleNewsUrl(feed, defaults.since), source, defaults, signal);
}
