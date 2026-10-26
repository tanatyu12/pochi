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
  /** ISO 8601. */
  publishedAt?: string;
  /** Plain text, at most maxContentChars. */
  content: string;
}
