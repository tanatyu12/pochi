import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set(["fbclid", "gclid"]);

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// The NUL separator keeps ("ab", "c") and ("a", "bc") from colliding.
export function itemId(...parts: string[]): string {
  return sha256Hex(parts.join("\u0000")).slice(0, 32);
}

export function normalizeUrl(raw: string, base?: string | URL): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  // URL keeps a bare "?" after the last param is deleted.
  return url.toString().replace(/\?$/, "");
}
