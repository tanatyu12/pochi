import { parseFeed, DetectError } from "feedsmith";
import type { RssFeed, Sources } from "../config/schema.js";
import type { Item, SourceKind } from "../types.js";
import { itemId, normalizeUrl, parseHttpUrl, urlKey } from "../util/hash.js";
import { fetchText } from "../util/http.js";
import { parseDate } from "../util/time.js";
import { htmlToLine, htmlToText, inlineHtmlToLine, plainTextToText, truncate } from "./html.js";

const TITLE_MAX_CHARS = 300;
// Full-content feeds (common on WordPress) easily pass the 2MB default.
export const FEED_MAX_BYTES = 10 * 1024 * 1024;

/**
 * One feed entry in a format-neutral shape. feedsmith has already decoded the XML, so
 * `html` is real HTML and `text` is literal text that must not be decoded again.
 */
export interface RawEntry {
  guid?: string;
  link?: string;
  /** "inline": HTML whose only markup is formatting tags, as RSS titles are in practice. */
  title?: { value: string; format: "text" | "html" | "inline" };
  published?: string;
  html?: string;
  text?: string;
}

export class FeedParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FeedParseError";
  }
}

type ParsedFeed = ReturnType<typeof parseFeed<string>>;
type RssItem = NonNullable<Extract<ParsedFeed, { format: "rss" }>["feed"]["items"]>[number];
type AtomEntry = NonNullable<Extract<ParsedFeed, { format: "atom" }>["feed"]["entries"]>[number];
type RdfItem = NonNullable<Extract<ParsedFeed, { format: "rdf" }>["feed"]["items"]>[number];
type JsonItem = NonNullable<Extract<ParsedFeed, { format: "json" }>["feed"]["items"]>[number];

/** Parses RSS 2.0, Atom, RDF (RSS 1.0) or JSON Feed. Throws FeedParseError otherwise. */
export function parseFeedText(text: string): RawEntry[] {
  let parsed: ParsedFeed;
  try {
    // No maxItems: feeds are not always newest first, so toItems sorts before cutting.
    parsed = parseFeed<string>(text);
  } catch (err) {
    // The message never quotes the input, which may be a whole HTML page.
    throw new FeedParseError(err instanceof DetectError ? "not a feed" : "malformed feed", { cause: err });
  }
  switch (parsed.format) {
    case "rss":
      return (parsed.feed.items ?? []).map(fromRss);
    case "atom":
      return (parsed.feed.entries ?? []).map(fromAtom);
    case "rdf":
      return (parsed.feed.items ?? []).map(fromRdf);
    case "json":
      return (parsed.feed.items ?? []).map(fromJson);
  }
}

function fromRss(item: RssItem): RawEntry {
  const guid = nonEmpty(item.guid?.value);
  // A permalink guid stands in for a missing <link>, but only when it is already absolute.
  const guidLink = guid && item.guid?.isPermaLink !== false && parseHttpUrl(guid) ? guid : undefined;
  return {
    guid,
    link: nonEmpty(item.link) ?? guidLink,
    title: inlineTitle(item.title),
    published: nonEmpty(item.pubDate) ?? nonEmpty(item.dc?.dates?.[0]),
    html: nonEmpty(item.content?.encoded) ?? nonEmpty(item.description),
  };
}

function fromAtom(entry: AtomEntry): RawEntry {
  const body = [entry.content, entry.summary]
    .map((c) => ({ value: nonEmpty(c?.value), kind: atomTextKind(c?.type) }))
    .find((c) => c.value !== undefined && c.kind !== undefined);
  const title = nonEmpty(entry.title?.value);
  const titleKind = atomTextKind(entry.title?.type);
  return {
    guid: nonEmpty(entry.id),
    link: atomLink(entry.links ?? []),
    title: title === undefined || titleKind === undefined ? undefined : { value: title, format: titleKind },
    published: nonEmpty(entry.published) ?? nonEmpty(entry.updated),
    html: body?.kind === "html" ? body.value : undefined,
    text: body?.kind === "text" ? body.value : undefined,
  };
}

// RFC 4287: text, html, xhtml or a MIME type. Other MIME types hold base64 or XML we cannot
// show, so they count as no value.
function atomTextKind(type: string | undefined): "text" | "html" | undefined {
  const t = mediaType(type);
  if (t === undefined || t === "text") return "text";
  if (t === "html" || t === "xhtml" || t === "text/html" || t === "application/xhtml+xml") return "html";
  return t.startsWith("text/") ? "text" : undefined;
}

// The entry's own page: rel="alternate" (the default when rel is missing), HTML first. Other
// rels (self, edit, enclosure, replies) point elsewhere, so without an alternate there is none.
function atomLink(links: NonNullable<AtomEntry["links"]>): string | undefined {
  const alternates = links.filter((l) => nonEmpty(l.href) && (l.rel === undefined || l.rel === "alternate"));
  const html = alternates.find((l) => l.type === undefined || mediaType(l.type) === "text/html");
  return nonEmpty((html ?? alternates[0])?.href);
}

// "text/html; charset=utf-8" → "text/html"
function mediaType(type: string | undefined): string | undefined {
  return nonEmpty(type?.split(";")[0])?.toLowerCase();
}

function fromRdf(item: RdfItem): RawEntry {
  return {
    // rdf:about is the item's URI, steadier than a link that may gain query parameters.
    guid: nonEmpty(item.rdf?.about),
    link: nonEmpty(item.link),
    title: inlineTitle(item.title),
    published: nonEmpty(item.dc?.dates?.[0]),
    html: nonEmpty(item.content?.encoded) ?? nonEmpty(item.description),
  };
}

function fromJson(item: JsonItem): RawEntry {
  const html = nonEmpty(item.content_html);
  const title = nonEmpty(item.title);
  return {
    guid: nonEmpty(item.id),
    link: nonEmpty(item.url) ?? nonEmpty(item.external_url),
    // JSON Feed titles are plain text.
    title: title === undefined ? undefined : { value: title, format: "text" },
    published: nonEmpty(item.date_published) ?? nonEmpty(item.date_modified),
    html,
    text: html ? undefined : (nonEmpty(item.content_text) ?? nonEmpty(item.summary)),
  };
}

// RSS and RDF titles often carry entities and formatting tags, but an escaped tag name such
// as "<dialog>" looks the same once decoded, so only formatting tags are dropped.
function inlineTitle(value: string | undefined): RawEntry["title"] {
  const v = nonEmpty(value);
  return v === undefined ? undefined : { value: v, format: "inline" };
}

function nonEmpty(s: string | undefined): string | undefined {
  const trimmed = s?.trim();
  return trimmed ? trimmed : undefined;
}

export interface ItemSource {
  id: string;
  name: string;
  kind?: SourceKind;
}

export interface ToItemsOptions {
  /** Relative links resolve against this: the feed URL after redirects. */
  baseUrl: string;
  itemsPerFeed: number;
  maxContentChars: number;
}

/**
 * Keeps the newest `itemsPerFeed` entries that have a usable link, one per guid or URL.
 * Undated entries go last.
 */
export function toItems(entries: RawEntry[], source: ItemSource, opts: ToItemsOptions): Item[] {
  const linked = entries.flatMap((entry, pos) => {
    const url = entry.link ? parseHttpUrl(entry.link, opts.baseUrl)?.toString() : undefined;
    if (!url) return [];
    const normalized = normalizeUrl(url) ?? url;
    return [{ entry, url, normalized, key: entry.guid ?? normalized, pos, date: parseDate(entry.published) }];
  });
  linked.sort((a, b) => {
    if (a.date && b.date) return b.date.getTime() - a.date.getTime() || a.pos - b.pos;
    if (a.date || b.date) return a.date ? -1 : 1;
    return a.pos - b.pos;
  });
  // After sorting, so the newest copy of a repeated entry is the one kept.
  const seen = new Set<string>();
  const unique = linked.filter(({ key, normalized }) => {
    if (seen.has(key) || seen.has(normalized)) return false;
    seen.add(key).add(normalized);
    return true;
  });
  return unique.slice(0, Math.max(0, opts.itemsPerFeed)).map(({ entry, url, normalized, key, date }) => ({
    id: itemId(source.id, key),
    sourceId: source.id,
    sourceName: source.name,
    kind: source.kind ?? "rss",
    title: toTitle(entry.title) || truncate(url, TITLE_MAX_CHARS),
    url,
    urlKey: urlKey(normalized),
    publishedAt: date?.toISOString(),
    content: entry.html
      ? htmlToText(entry.html, opts.maxContentChars)
      : plainTextToText(entry.text ?? "", opts.maxContentChars),
  }));
}

function toTitle(title: RawEntry["title"]): string {
  if (!title) return "";
  const text =
    title.format === "html"
      ? htmlToLine(title.value)
      : title.format === "inline"
        ? inlineHtmlToLine(title.value)
        : title.value.replace(/\s+/g, " ").trim();
  return truncate(text, TITLE_MAX_CHARS);
}

/** `url` is the feed URL after redirects. */
export async function fetchFeedEntries(
  url: string,
  signal?: AbortSignal,
): Promise<{ entries: RawEntry[]; url: string }> {
  const res = await fetchText(url, { signal, maxBytes: FEED_MAX_BYTES });
  return { entries: parseFeedText(res.text), url: res.url };
}

/** `filter` runs before toItems, so entries it drops do not count towards itemsPerFeed. */
export async function fetchFeedItems(
  url: string,
  source: ItemSource,
  defaults: Sources["defaults"],
  signal?: AbortSignal,
  filter: (entries: RawEntry[]) => RawEntry[] = (entries) => entries,
): Promise<Item[]> {
  const feed = await fetchFeedEntries(url, signal);
  return toItems(filter(feed.entries), source, { baseUrl: feed.url, ...defaults });
}

export function fetchRssItems(feed: RssFeed, defaults: Sources["defaults"], signal?: AbortSignal): Promise<Item[]> {
  return fetchFeedItems(feed.url, feed, defaults, signal);
}
