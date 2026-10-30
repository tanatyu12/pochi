import type { Impact, Sources } from "./config/schema.js";

export type SourceKind = "rss" | "github" | "googlenews" | "tavily";

/**
 * What every source is fetched with: the configured defaults and, when the run knows when it last
 * ran, since. Sources then take what was published since rather than only their newest few.
 */
export type FetchDefaults = Sources["defaults"] & {
  since?: Date;
  /** Where source secrets (GITHUB_TOKEN, TAVILY_API_KEY) come from; process.env when left out. */
  env?: NodeJS.ProcessEnv;
};

/** A collected article, normalized across sources. */
export interface Item {
  /** First 32 hex digits of a sha256 over the source and the entry's identity. */
  id: string;
  sourceId: string;
  sourceName: string;
  kind: SourceKind;
  /** At most 300 characters, on one line. */
  title: string;
  /** Absolute http(s) URL. */
  url: string;
  /** Hash of the normalized URL: the same page has the same key whichever source returned it. */
  urlKey: string;
  /** ISO 8601. */
  publishedAt?: string;
  /** Plain text, at most maxContentChars. */
  content: string;
}

/** What the Analyze step said about a relevant item. */
export interface Insight {
  item: Item;
  title: string;
  /** May be empty when the model left it blank. */
  summary: string;
  impact: Impact;
  /** May be empty when the model left it blank. */
  action: string;
  /** Other articles on the same story, newest first; only item was analyzed. */
  related?: Item[];
}
