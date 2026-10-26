import type { GithubFeed, QueryConfig, RssFeed, Sources } from "../config/schema.js";
import type { Item, SourceKind } from "../types.js";
import { pLimit } from "../util/concurrency.js";
import { log } from "../util/log.js";
import { fetchGithubItems } from "./github.js";
import { fetchRssItems } from "./rss.js";
import { fetchTavilyItems, tavilyApiKey } from "./tavily.js";

const DEFAULT_CONCURRENCY = 4;

export type SourceConfig =
  | { kind: "rss"; feed: RssFeed }
  | { kind: "github"; feed: GithubFeed }
  | { kind: "tavily"; query: QueryConfig };

export interface SourceFailure {
  sourceId: string;
  sourceName: string;
  kind: SourceKind;
  error: unknown;
}

export interface CollectResult {
  /** Without duplicates, in config order (feeds, then queries); the first copy of an item wins. */
  items: Item[];
  /** Sources actually fetched. Queries skipped for lack of a Tavily key are not counted. */
  attempted: number;
  /** In config order. */
  failures: SourceFailure[];
  /** Query ids skipped because TAVILY_API_KEY is not set. */
  skipped: string[];
}

export interface CollectOptions {
  signal?: AbortSignal;
  concurrency?: number;
}

export function fetchSource(source: SourceConfig, defaults: Sources["defaults"], signal?: AbortSignal): Promise<Item[]> {
  switch (source.kind) {
    case "rss":
      return fetchRssItems(source.feed, defaults, signal);
    case "github":
      return fetchGithubItems(source.feed, defaults, signal);
    case "tavily":
      return fetchTavilyItems(source.query, defaults, signal);
  }
}

export function sourceInfo(source: SourceConfig): { id: string; name: string; kind: SourceKind } {
  return source.kind === "tavily"
    ? { id: source.query.id, name: source.query.query, kind: "tavily" }
    : { id: source.feed.id, name: source.feed.name, kind: source.kind };
}

/**
 * Fetches every source, at most `concurrency` at a time. A failing source is recorded and
 * skipped; deciding what "all sources failed" means is left to the caller.
 */
export async function collectAll(sources: Sources, opts: CollectOptions = {}): Promise<CollectResult> {
  const { signal } = opts;
  const configs: SourceConfig[] = sources.feeds.map((feed) =>
    feed.type === "github" ? { kind: "github", feed } : { kind: "rss", feed },
  );
  // Skipped here rather than relying on fetchTavilyItems returning [], so they do not count as successes.
  const skipped: string[] = [];
  if (tavilyApiKey()) {
    configs.push(...sources.queries.map((query) => ({ kind: "tavily" as const, query })));
  } else if (sources.queries.length > 0) {
    skipped.push(...sources.queries.map((q) => q.id));
    const message = `TAVILY_API_KEY is not set; skipping ${skipped.length} ${skipped.length === 1 ? "query" : "queries"}`;
    // With nothing else to fetch, the run would quietly collect nothing.
    if (configs.length === 0) log.warn(message);
    else log.info(message);
  }

  const limit = pLimit(concurrencyOf(opts.concurrency));
  // Indexed by source, so the result does not depend on which fetch finishes first.
  const settled = await Promise.all(
    configs.map((config) =>
      limit(async (): Promise<Settled> => {
        // Queued sources are not started once the run is interrupted.
        if (signal?.aborted) return { aborted: true };
        const info = sourceInfo(config);
        try {
          const items = await fetchSource(config, sources.defaults, signal);
          log.debug(`source ${info.id}: ${items.length} item${items.length === 1 ? "" : "s"}`);
          return { items };
        } catch (error) {
          // An abort is not the source's fault; it is rethrown below instead.
          if (isAbort(error, signal)) return { aborted: true };
          log.warn(`source ${info.id} failed`, error);
          return { failure: { sourceId: info.id, sourceName: info.name, kind: info.kind, error } };
        }
      }),
    ),
  );
  // Otherwise an interrupted run would look like one where every source failed. An abort
  // that arrives after every fetch has finished cut nothing short, so the results stand.
  if (signal && settled.some((s) => s.aborted)) throw signal.reason;

  return {
    items: dedupe(settled.flatMap((s) => s.items ?? [])),
    attempted: configs.length,
    failures: settled.flatMap((s) => (s.failure ? [s.failure] : [])),
    skipped,
  };
}

/** Every key the state file should know this item by, so a page is not notified twice. */
export function stateKeys(item: Item): string[] {
  return item.id === item.urlKey ? [item.id] : [item.id, item.urlKey];
}

type Settled = { items?: Item[]; failure?: SourceFailure; aborted?: true };

function concurrencyOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (Number.isInteger(value) && value >= 1) return value;
  log.warn(`invalid concurrency ${value}; using ${DEFAULT_CONCURRENCY}`);
  return DEFAULT_CONCURRENCY;
}

// util/http rethrows the caller's abort as is; AbortError covers fetchers that wrap it.
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  return error === signal.reason || (error instanceof Error && error.name === "AbortError");
}

// Sources dedupe within themselves; across them, the same page can come from a feed and a
// Tavily query under different ids, so the URL is checked too.
function dedupe(items: Item[]): Item[] {
  const keys = new Set<string>();
  return items.filter((item) => {
    if (keys.has(item.id) || keys.has(item.urlKey)) return false;
    keys.add(item.id).add(item.urlKey);
    return true;
  });
}
