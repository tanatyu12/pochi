import { parseFeed, DetectError } from "feedsmith";
import type { RssFeed, Sources } from "../config/schema.js";
import type { Item, SourceKind } from "../types.js";
import { itemId, normalizeUrl, parseHttpUrl } from "../util/hash.js";
import { fetchText } from "../util/http.js";
import { parseDate } from "../util/time.js";
import { htmlToText, truncate } from "./html.js";

const TITLE_MAX_CHARS = 300;

/**
 * One feed entry in a format-neutral shape. feedsmith has already decoded the XML, so
 * `html` is real HTML and `text` is literal text that must not be decoded again.
 */
export interface RawEntry {
  guid?: string;
  link?: string;
  title?: { value: string; html: boolean };
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
    title: htmlTitle(item.title),
    published: nonEmpty(item.pubDate) ?? nonEmpty(item.dc?.dates?.[0]),
    html: nonEmpty(item.content?.encoded) ?? nonEmpty(item.description),
  };
}

function fromAtom(entry: AtomEntry): RawEntry {
  const body = entry.content?.value ? entry.content : entry.summary;
  const bodyValue = nonEmpty(body?.value);
  const isText = body?.type === undefined || body.type === "text";
  const title = nonEmpty(entry.title?.value);
  return {
    guid: nonEmpty(entry.id),
    link: atomLink(entry.links ?? []),
    title: title === undefined ? undefined : { value: title, html: isHtmlType(entry.title?.type) },
    published: nonEmpty(entry.published) ?? nonEmpty(entry.updated),
    html: isText ? undefined : bodyValue,
    text: isText ? bodyValue : undefined,
  };
}

// The entry's own page: rel="alternate" (the default when rel is missing), HTML first.
function atomLink(links: NonNullable<AtomEntry["links"]>): string | undefined {
  const alternates = links.filter((l) => l.href && (l.rel === undefined || l.rel === "alternate"));
  const html = alternates.find((l) => l.type === undefined || l.type === "text/html");
  return nonEmpty((html ?? alternates[0] ?? links[0])?.href);
}

function fromRdf(item: RdfItem): RawEntry {
  return {
    link: nonEmpty(item.link),
    title: htmlTitle(item.title),
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
    title: title === undefined ? undefined : { value: title, html: false },
    published: nonEmpty(item.date_published) ?? nonEmpty(item.date_modified),
    html,
    text: html ? undefined : (nonEmpty(item.content_text) ?? nonEmpty(item.summary)),
  };
}

// RSS and RDF titles often carry markup or entities, so they are read as HTML.
function htmlTitle(value: string | undefined): RawEntry["title"] {
  const v = nonEmpty(value);
  return v === undefined ? undefined : { value: v, html: true };
}

function isHtmlType(type: string | undefined): boolean {
  return type === "html" || type === "xhtml";
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

/** Keeps the newest `itemsPerFeed` entries that have a usable link. Undated entries go last. */
export function toItems(entries: RawEntry[], source: ItemSource, opts: ToItemsOptions): Item[] {
  const linked = entries.flatMap((entry, pos) => {
    const url = entry.link ? parseHttpUrl(entry.link, opts.baseUrl)?.toString() : undefined;
    if (!url) return [];
    return [{ entry, url, pos, date: parseDate(entry.published) }];
  });
  linked.sort((a, b) => {
    if (a.date && b.date) return b.date.getTime() - a.date.getTime() || a.pos - b.pos;
    if (a.date || b.date) return a.date ? -1 : 1;
    return a.pos - b.pos;
  });
  return linked.slice(0, Math.max(0, opts.itemsPerFeed)).map(({ entry, url, date }) => ({
    id: itemId(source.id, entry.guid ?? normalizeUrl(url) ?? url),
    sourceId: source.id,
    sourceName: source.name,
    kind: source.kind ?? "rss",
    title: toTitle(entry.title) || truncate(url, TITLE_MAX_CHARS),
    url,
    publishedAt: date?.toISOString(),
    content: entry.html
      ? htmlToText(entry.html, opts.maxContentChars)
      : plainText(entry.text ?? "", opts.maxContentChars),
  }));
}

function toTitle(title: RawEntry["title"]): string {
  if (!title) return "";
  const text = title.html ? htmlToText(title.value, Number.POSITIVE_INFINITY) : title.value;
  return truncate(text.replace(/\s+/g, " ").trim(), TITLE_MAX_CHARS);
}

function plainText(text: string, maxChars: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l !== "");
  return truncate(lines.join("\n"), maxChars);
}

export async function fetchRssItems(
  feed: RssFeed,
  defaults: Sources["defaults"],
  signal?: AbortSignal,
): Promise<Item[]> {
  const res = await fetchText(feed.url, { signal });
  return toItems(parseFeedText(res.text), feed, { baseUrl: res.url, ...defaults });
}
