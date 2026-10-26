import { decodeHTMLAttribute } from "entities";
import { pLimit } from "../util/concurrency.js";
import { parseHttpUrl } from "../util/hash.js";
import { HttpError, fetchText } from "../util/http.js";
import { log } from "../util/log.js";
import { FeedParseError, fetchFeedEntries, parseFeedText } from "./rss.js";

const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/feed+json"]);
// Tried in order when the page advertises no working feed. Absolute, so they resolve against the origin.
const FALLBACK_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml"];
const VERIFY_CONCURRENCY = 4;

export interface DiscoveredFeed {
  /** The feed URL after redirects, fetched and parsed successfully. */
  url: string;
  /** The title attribute of the <link> that advertised it. */
  title?: string;
}

export interface FeedLink {
  url: string;
  title?: string;
}

/**
 * Finds the feeds for a page: the URL itself if it is a feed, else the feeds its <link>
 * elements advertise, else the first common feed path that works. Every result has been
 * fetched and parsed. An empty array means no feed; a page that cannot be fetched throws.
 */
export async function discoverFeeds(url: string, signal?: AbortSignal): Promise<DiscoveredFeed[]> {
  const page = await fetchText(url, { signal });
  try {
    parseFeedText(page.text);
    return [{ url: page.url }];
  } catch (err) {
    if (!(err instanceof FeedParseError)) throw err;
  }

  const limit = pLimit(VERIFY_CONCURRENCY);
  const checked = await Promise.all(
    findFeedLinks(page.text, page.url).map((link) =>
      limit(async () => {
        const feedUrl = await verifyFeed(link.url, signal);
        return feedUrl === undefined ? undefined : { ...link, url: feedUrl };
      }),
    ),
  );
  // Two links may redirect to the same feed.
  const seen = new Set<string>();
  const found = checked.filter((feed): feed is DiscoveredFeed => {
    if (feed === undefined || seen.has(feed.url)) return false;
    seen.add(feed.url);
    return true;
  });
  if (found.length > 0) return found;

  // One at a time, stopping at the first hit: /feed and /feed/ usually serve the same feed.
  for (const path of FALLBACK_PATHS) {
    const feedUrl = await verifyFeed(new URL(path, page.url).toString(), signal);
    if (feedUrl !== undefined) return [{ url: feedUrl }];
  }
  return [];
}

/** The URL after redirects if it serves a parsable feed. */
async function verifyFeed(url: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    return (await fetchFeedEntries(url, signal)).url;
  } catch (err) {
    if (!(err instanceof HttpError || err instanceof FeedParseError)) throw err;
    log.debug(`not a feed: ${url}`, err);
    return undefined;
  }
}

/**
 * The feeds advertised by `<link rel="alternate" type="...">` in the head, resolved against
 * `<base href>` or `pageUrl` (the page URL after redirects), in document order.
 */
export function findFeedLinks(html: string, pageUrl: string): FeedLink[] {
  const withoutComments = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const headEnd = withoutComments.search(/<\/head\s*>|<body[\s>]/i);
  const head = headEnd === -1 ? withoutComments : withoutComments.slice(0, headEnd);

  const baseHref = attrValue(head.match(/<base\b[^>]*>/i)?.[0], "href");
  const base = (baseHref !== undefined && parseHttpUrl(baseHref, pageUrl)) || pageUrl;

  const seen = new Set<string>();
  const links: FeedLink[] = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttrs(tag);
    const rel = attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    const type = attrs.get("type")?.split(";")[0]?.trim().toLowerCase();
    const href = attrs.get("href");
    if (!rel.includes("alternate") || type === undefined || !FEED_TYPES.has(type) || !href) continue;
    const url = parseHttpUrl(href.trim(), base)?.toString();
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const title = attrs.get("title")?.trim();
    links.push(title ? { url, title } : { url });
  }
  return links;
}

function attrValue(tag: string | undefined, name: string): string | undefined {
  return tag === undefined ? undefined : parseAttrs(tag).get(name);
}

// Names are lowercased; the first occurrence wins, as in browsers. Values are decoded.
function parseAttrs(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const inner = tag.replace(/^<[a-z]+/i, "");
  for (const m of inner.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeHTMLAttribute(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}
