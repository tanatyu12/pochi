import { sha256Hex } from "../../util/hash.js";

const QUERY_ID_MAX_CHARS = 32;

/** Turns a repo or host name into a source id that is not in taken. */
export function sourceIdFrom(raw: string, taken: ReadonlySet<string>): string {
  return uniqueId(slug(raw) || "source", taken);
}

/**
 * A source id for a query that is not in taken: an ASCII query's words, cut short, or else a
 * hash of the query, which (unlike a counter) does not change when queries are reordered.
 */
export function queryIdFrom(query: string, taken: ReadonlySet<string>): string {
  const words = /^[\x20-\x7e]*$/.test(query) ? cutAtWord(slug(query), QUERY_ID_MAX_CHARS) : "";
  return uniqueId(words || `query-${sha256Hex(query.toLowerCase()).slice(0, 8)}`, taken);
}

export function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
}

/** At most max characters, cut after a whole word where there is one. */
export function cutAtWord(id: string, max: number): string {
  if (id.length <= max) return id;
  const cut = id.slice(0, max + 1);
  const at = cut.lastIndexOf("-");
  return (at > 0 ? cut.slice(0, at) : cut.slice(0, max)).replace(/[-_]+$/, "");
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
