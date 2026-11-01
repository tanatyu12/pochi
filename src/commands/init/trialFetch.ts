import { SourcesSchema } from "../../config/schema.js";
import { type SourceConfig, type SourceOutcome, fetchEach, sourceConfigs, sourceInfo } from "../../sources/index.js";
import { PromptCancelled } from "../../util/prompter.js";
import { displayLine, plural } from "../../util/text.js";
import { type FeedInput, type QueryInput, keyOf } from "./keys.js";
import { SHOWN_MAX_CHARS, type SourceSession, errorLine } from "./session.js";

/** Shows the latest item of each source; asks whether to keep the ones that failed or have nothing yet. */
export async function trialFetch(
  s: SourceSession,
  feeds: FeedInput[],
  queries: QueryInput[],
): Promise<{ feeds: FeedInput[]; queries: QueryInput[] }> {
  const { p, signal } = s;
  const sources = SourcesSchema.parse({ version: 1, feeds, queries });
  // Queries only get here with a Tavily key.
  const configs = sourceConfigs(sources, true);
  // GitHub already showed the latest item of the checked feeds. Found by id, which is unique
  // in a session: parsing made new objects.
  const byId = new Map(feeds.map((f) => [f.id, f]));
  const checkedFeed = (source: SourceConfig) => {
    const feed = source.kind === "tavily" ? undefined : byId.get(source.feed.id);
    return feed && s.checked.has(feed) ? feed : undefined;
  };
  const toFetch = configs.filter((source) => !checkedFeed(source));
  const fetched =
    toFetch.length === 0
      ? []
      : await p.spin(
          `Fetching the latest from ${plural(toFetch.length, "source")}`,
          () => fetchEach(toFetch, sources.defaults, { signal }),
          signal,
        );
  if (signal?.aborted || fetched.some((o) => "aborted" in o)) throw new PromptCancelled();
  // Each outcome carries the config it was fetched for.
  const byConfig = new Map(fetched.map((o) => [o.source, o]));
  const outcomes = configs.flatMap((source): SourceOutcome[] => {
    const feed = checkedFeed(source);
    if (!feed) {
      const outcome = byConfig.get(source);
      return outcome ? [outcome] : [];
    }
    const latest = s.checked.get(feed);
    return [{ source, items: latest ? [latest] : [] }];
  });

  const rejected = new Set<string>();
  for (const outcome of outcomes) {
    const { id, name, kind } = sourceInfo(outcome.source);
    const label = displayLine(name, SHOWN_MAX_CHARS);
    let ok = true;
    if ("error" in outcome) {
      ok = false;
      p.warn(`${label} (${kind}) failed: ${errorLine(outcome.error)}`);
    } else if ("items" in outcome) {
      const item = outcome.items[0];
      p.note(
        item
          ? [
              displayLine(item.title, SHOWN_MAX_CHARS),
              ...(item.publishedAt ? [item.publishedAt.slice(0, 10)] : []),
              displayLine(item.url, SHOWN_MAX_CHARS),
            ].join("\n")
          : "No items yet.",
        `${label} (${kind})`,
      );
      // The user just picked it, so only one that brought nothing is asked about again.
      if (item) continue;
    }
    if (!(await p.confirm({ message: `Watch ${label} anyway?`, initialValue: ok }))) rejected.add(id);
  }

  // A rejected source may be added again later, perhaps another way.
  for (const source of [...feeds, ...queries]) {
    if (!rejected.has(source.id)) continue;
    s.ids.delete(source.id);
    s.keys.delete(keyOf(source));
  }
  return { feeds: feeds.filter((f) => !rejected.has(f.id)), queries: queries.filter((q) => !rejected.has(q.id)) };
}
