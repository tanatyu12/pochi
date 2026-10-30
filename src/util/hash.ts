import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set(["fbclid", "gclid"]);

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// The NUL separator keeps ("ab", "c") and ("a", "bc") from colliding.
export function itemId(...parts: string[]): string {
  return sha256Hex(parts.join("\u0000")).slice(0, 32);
}

/** Takes a URL already passed through normalizeUrl. */
export function urlKey(normalized: string): string {
  return itemId("url", normalized);
}

export function parseHttpUrl(raw: string, base?: string | URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}

export interface NormalizeUrlOptions {
  /** Keep a plain anchor (#section) too, for telling apart entries that link into one page. */
  keepFragment?: boolean;
}

/**
 * Drops tracking params, a trailing slash and the fragment, so the same page has one form.
 * A route-like fragment (#/news/1, #!/news/1) is the page on a hash-routed site, so it stays.
 * A URL without a fragment normalizes as it always has, so keys already in state stay valid.
 */
export function normalizeUrl(raw: string, base?: string | URL, opts: NormalizeUrlOptions = {}): string | undefined {
  const url = parseHttpUrl(raw.trim(), base);
  if (!url) return undefined;
  if (!opts.keepFragment && !isRouteFragment(url.hash)) url.hash = "";
  // Filter the raw pairs: URLSearchParams would re-encode the whole query (%20 -> +),
  // so the same URL would normalize differently depending on whether it had a utm_ param.
  const kept = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair !== "" && !isTrackingParam(pair.split("=", 1)[0] ?? ""));
  url.search = kept.length > 0 ? `?${kept.join("&")}` : "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  return url.toString();
}

function isRouteFragment(hash: string): boolean {
  return hash.startsWith("#/") || hash.startsWith("#!");
}

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}
