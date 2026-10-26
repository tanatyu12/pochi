import type { Impact } from "./config/schema.js";

export type SourceKind = "rss" | "github" | "tavily";

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

/** An item that passed Analyze, with the model's write-up (in the configured language). */
export interface Finding {
  item: Item;
  title: string;
  summary: string;
  impact: Impact;
  action: string;
}
