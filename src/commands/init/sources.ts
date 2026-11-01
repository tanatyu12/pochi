import type { SourcesInput } from "../../config/schema.js";
import { askFeeds } from "./feeds.js";
import type { FeedInput } from "./keys.js";
import { askNewsSearches, askWebSearches } from "./searches.js";
import type { SourceSession } from "./session.js";
import { trialFetch } from "./trialFetch.js";

/**
 * Asks for feeds and queries, fetches the latest item of each and keeps them, asking about the
 * ones that failed or have nothing yet. Repeats until at least one is kept, since sources.yml needs one.
 */
export async function askSources(s: SourceSession, proposed: FeedInput[] = []): Promise<SourcesInput> {
  // Proposed feeds were claimed already; the first trial fetch tries them with the typed ones.
  let pending = proposed;
  for (;;) {
    const feeds = await askFeeds(s, pending);
    pending = [];
    feeds.push(...(await askNewsSearches(s)));
    const queries = await askWebSearches(s);
    if (feeds.length + queries.length > 0) {
      const kept = await trialFetch(s, feeds, queries);
      s.feeds.push(...kept.feeds);
      s.queries.push(...kept.queries);
    }
    if (s.feeds.length + s.queries.length > 0) break;
    s.p.warn("Nothing to watch yet; add a source.");
  }
  return { version: 1, feeds: s.feeds, ...(s.queries.length > 0 && { queries: s.queries }) };
}
