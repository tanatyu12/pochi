import type { GithubFeed, GoogleNewsFeed, QueryConfig, RssFeed, Sources } from "../config/schema.js";
import type { FetchDefaults, Item, SourceKind } from "../types.js";
import { pLimit } from "../util/concurrency.js";
import { log } from "../util/log.js";
import { plural } from "../util/text.js";
import { fetchGithubItems } from "./github.js";
import { fetchGoogleNewsItems, googleNewsName } from "./googlenews.js";
import { fetchRssItems } from "./rss.js";
import { fetchTavilyItems, tavilyApiKey } from "./tavily.js";

const DEFAULT_CONCURRENCY = 4;

export type SourceConfig =
  | { kind: "rss"; feed: RssFeed }
  | { kind: "github"; feed: GithubFeed }
  | { kind: "googlenews"; feed: GoogleNewsFeed }
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
  /** Take what each source published since then, not only its newest few. */
  since?: Date;
  concurrency?: number;
  /** Where source secrets come from; process.env when left out. */
  env?: NodeJS.ProcessEnv;
}

export function fetchSource(source: SourceConfig, defaults: FetchDefaults, signal?: AbortSignal): Promise<Item[]> {
  switch (source.kind) {
    case "rss":
      return fetchRssItems(source.feed, defaults, signal);
    case "github":
      return fetchGithubItems(source.feed, defaults, signal);
    case "googlenews":
      return fetchGoogleNewsItems(source.feed, defaults, signal);
    case "tavily":
      return fetchTavilyItems(source.query, defaults, signal);
  }
}

/** Feeds in config order, then queries; queries only when withQueries (a Tavily key is set). */
export function sourceConfigs(sources: Sources, withQueries: boolean): SourceConfig[] {
  const configs = sources.feeds.map((feed): SourceConfig => {
    switch (feed.type) {
      case "github":
        return { kind: "github", feed };
      case "googlenews":
        return { kind: "googlenews", feed };
      case "rss":
        return { kind: "rss", feed };
    }
  });
  if (withQueries) configs.push(...sources.queries.map((query) => ({ kind: "tavily" as const, query })));
  return configs;
}

export function sourceInfo(source: SourceConfig): { id: string; name: string; kind: SourceKind } {
  switch (source.kind) {
    case "tavily":
      return { id: source.query.id, name: source.query.query, kind: "tavily" };
    case "googlenews":
      return { id: source.feed.id, name: googleNewsName(source.feed), kind: "googlenews" };
    default:
      return { id: source.feed.id, name: source.feed.name, kind: source.kind };
  }
}

export type SourceOutcome =
  | { source: SourceConfig; items: Item[] }
  | { source: SourceConfig; error: unknown }
  | { source: SourceConfig; aborted: true };

/**
 * Fetches each source, at most `concurrency` at a time, and settles every one in input order.
 * Never throws: once `signal` is aborted, queued sources are not started and a fetch the abort
 * cut short is `aborted`, not an error. What an abort means is left to the caller.
 */
export async function fetchEach(
  configs: SourceConfig[],
  defaults: FetchDefaults,
  opts: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<SourceOutcome[]> {
  const { signal } = opts;
  const limit = pLimit(opts.concurrency ?? DEFAULT_CONCURRENCY);
  // Indexed by source, so the result does not depend on which fetch finishes first.
  return Promise.all(
    configs.map((source) =>
      limit(async (): Promise<SourceOutcome> => {
        if (signal?.aborted) return { source, aborted: true };
        try {
          return { source, items: await fetchSource(source, defaults, signal) };
        } catch (error) {
          // An abort is not the source's fault.
          if (isAbort(error, signal)) return { source, aborted: true };
          return { source, error };
        }
      }),
    ),
  );
}

/**
 * Fetches every source, at most `concurrency` at a time. A failing source is recorded and
 * skipped; deciding what "all sources failed" means is left to the caller.
 */
export async function collectAll(sources: Sources, opts: CollectOptions = {}): Promise<CollectResult> {
  const { signal } = opts;
  const withQueries = tavilyApiKey(opts.env) !== undefined;
  const configs = sourceConfigs(sources, withQueries);
  // Skipped here rather than relying on fetchTavilyItems returning [], so they do not count as successes.
  const skipped: string[] = [];
  if (!withQueries && sources.queries.length > 0) {
    skipped.push(...sources.queries.map((q) => q.id));
    const message = `TAVILY_API_KEY is not set; skipping ${plural(skipped.length, "query", "queries")}`;
    // With nothing else to fetch, the run would quietly collect nothing.
    if (configs.length === 0) log.warn(message);
    else log.info(message);
  }

  const outcomes = await fetchEach(configs, { ...sources.defaults, since: opts.since, env: opts.env }, {
    signal,
    concurrency: concurrencyOf(opts.concurrency),
  });
  const failures: SourceFailure[] = [];
  for (const outcome of outcomes) {
    const info = sourceInfo(outcome.source);
    if ("items" in outcome) {
      log.debug(`source ${info.id}: ${plural(outcome.items.length, "item")}`);
    } else if ("error" in outcome) {
      log.warn(`source ${info.id} failed`, outcome.error);
      failures.push({ sourceId: info.id, sourceName: info.name, kind: info.kind, error: outcome.error });
    }
  }
  // Otherwise an interrupted run would look like one where every source failed. An abort
  // that arrives after every fetch has finished cut nothing short, so the results stand.
  if (signal && outcomes.some((o) => "aborted" in o)) throw signal.reason;

  return {
    items: dedupe(outcomes.flatMap((o) => ("items" in o ? o.items : []))),
    attempted: configs.length,
    failures,
    skipped,
  };
}

/** Every key the state file should know this item by, so a page is not notified twice. */
export function stateKeys(item: Item): string[] {
  return item.id === item.urlKey ? [item.id] : [item.id, item.urlKey];
}


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
