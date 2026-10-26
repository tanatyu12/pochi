import { decodeHTMLAttribute } from "entities";
import { pLimit } from "../util/concurrency.js";
import { parseHttpUrl } from "../util/hash.js";
import { HttpError, fetchText } from "../util/http.js";
import { log } from "../util/log.js";
import { FEED_MAX_BYTES, FeedParseError, fetchFeedEntries, parseFeedText } from "./rss.js";

// Every candidate is fetched and parsed, so a loose type such as text/xml costs a request, not a wrong result.
const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/rdf+xml",
  "application/x-rss+xml",
  "application/x-atom+xml",
  "text/xml",
]);
// Tried in order when the page advertises no working feed. Relative, so they resolve under the
// page's path: on a shared host (dev.to/someuser) the root feed is the whole site's, not the blog's.
const FALLBACK_PATHS = ["feed", "feed/", "rss", "rss.xml", "atom.xml", "feed.xml", "index.xml"];
// Matches a whole start tag, including a ">" inside a quoted attribute value.
const TAG_BODY = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*>`;
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
 * elements advertise, else the first common feed path under the page that works. Every result
 * has been fetched and parsed. An empty array means no feed was found. A page that cannot be
 * fetched throws, and so does a candidate that failed for a reason that may pass (timeout,
 * network, 5xx, 429, too large) when nothing else was found, so "no feed" is never a guess.
 */
export async function discoverFeeds(url: string, signal?: AbortSignal): Promise<DiscoveredFeed[]> {
  // The URL may itself be a full-content feed, so it gets the feed size limit.
  const page = await fetchText(url, { signal, maxBytes: FEED_MAX_BYTES });
  try {
    parseFeedText(page.text);
    return [{ url: page.url }];
  } catch (err) {
    if (!(err instanceof FeedParseError)) throw err;
  }

  const limit = pLimit(VERIFY_CONCURRENCY);
  const links = findFeedLinks(page.text, page.url);
  const checks = await Promise.all(links.map((link) => limit(() => verifyFeed(link.url, signal))));
  const failed: HttpError[] = [];
  // Two links may redirect to the same feed.
  const seen = new Set<string>();
  const found: DiscoveredFeed[] = [];
  checks.forEach((check, i) => {
    if (check instanceof HttpError) failed.push(check);
    else if (check !== undefined && !seen.has(check)) {
      seen.add(check);
      found.push({ ...links[i]!, url: check });
    }
  });
  if (found.length > 0) {
    for (const err of failed) log.warn(`could not check an advertised feed: ${err.url}`, err);
    return found;
  }
  // Probing the common paths now could return a different feed (comments, the whole site).
  if (failed.length > 0) throw failed[0];

  // One at a time, stopping at the first hit: feed and feed/ usually serve the same feed.
  const dir = new URL(page.url);
  dir.search = "";
  dir.hash = "";
  if (!dir.pathname.endsWith("/")) dir.pathname += "/";
  for (const path of FALLBACK_PATHS) {
    const check = await verifyFeed(new URL(path, dir).toString(), signal);
    if (check instanceof HttpError) failed.push(check);
    else if (check !== undefined) return [{ url: check }];
  }
  if (failed.length > 0) throw failed[0];
  return [];
}

/**
 * The URL after redirects if it serves a parsable feed, undefined if it does not, or the
 * HttpError if the check failed for a reason that may pass on another try.
 */
async function verifyFeed(url: string, signal: AbortSignal | undefined): Promise<string | HttpError | undefined> {
  try {
    return (await fetchFeedEntries(url, signal)).url;
  } catch (err) {
    if (err instanceof HttpError && isTransient(err)) return err;
    if (!(err instanceof HttpError || err instanceof FeedParseError)) throw err;
    log.debug(`not a feed: ${url}`, err);
    return undefined;
  }
}

function isTransient(err: HttpError): boolean {
  if (err.kind === "status") return err.status === 429 || (err.status ?? 0) >= 500;
  return err.kind !== "invalid_url";
}

/**
 * The feeds advertised by `<link rel="alternate" type="...">` in the head, resolved against
 * `<base href>` or `pageUrl` (the page URL after redirects), in document order.
 */
export function findFeedLinks(html: string, pageUrl: string): FeedLink[] {
  // Script and style bodies may contain "</head>" or "<link" in strings.
  const markup = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const headEnd = markup.search(/<\/head\s*>|<body[\s>]/i);
  const head = headEnd === -1 ? markup : markup.slice(0, headEnd);

  const baseHref = attrValue(head.match(new RegExp(`<base\\b${TAG_BODY}`, "i"))?.[0], "href");
  const base = (baseHref !== undefined && parseHttpUrl(baseHref, pageUrl)) || pageUrl;

  const seen = new Set<string>();
  const links: FeedLink[] = [];
  for (const [tag] of head.matchAll(new RegExp(`<link\\b${TAG_BODY}`, "gi"))) {
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
