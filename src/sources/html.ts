import { decodeHTML } from "entities";

// Mark heading lines and lines from <pre> between passes. Input control characters are
// stripped first, so they can only come from us.
const HEADING = "\u0001";
const CODE = "\u0002";
const MARKERS = /([\u0001\u0002])/;
const MARKER_CHARS = /[\u0001\u0002]/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

// Comments and the start and end tags of dropped elements, found in one left-to-right pass.
const HIDDEN =
  /<!--|<(\/?)(script|style|noscript|iframe|template|svg|head|nav|header|footer|aside|form)(?=[\s/>]|$)([^>]*)(>?)/gi;
// Raw text: tags and comments inside these mean nothing, so skip straight to the end tag.
const RAW_TEXT_END: Record<string, RegExp> = {
  script: /<\/script\s*>/gi,
  style: /<\/style\s*>/gi,
  noscript: /<\/noscript\s*>/gi,
  iframe: /<\/iframe\s*>/gi,
};
const COMMENT_END = /-->/g;
// "/>" closes the tag unless the "/" belongs to an unquoted value (src=https://x/).
const SELF_CLOSING = /(?<!=\s*[^\s"']*)\/$/;
// Stops at the next <h…> or </h…>, so many unclosed headings stay linear.
const HEADING_ELEMENT = /<h[1-6]\b[^>]*>((?:(?!<\/?h[1-6]\b)[\s\S])*)<\/h[1-6]\s*>/gi;
// Fallback for headings without an end tag.
const HEADING_OPEN = /<h[1-6]\b[^>]*>/gi;
const PRE_ELEMENT = /<pre\b[^>]*>((?:(?!<\/?pre\b)[\s\S])*)<\/pre\s*>/gi;
const BLOCK_TAG =
  /<\/?(?:p|div|br|li|dt|dd|tr|blockquote|pre|ul|ol|dl|table|section|article|main|figcaption|hr|h[1-6])\b[^>]*>/gi;
const CELL_TAG = /<\/?t[dh]\b[^>]*>/gi;
// Only things shaped like tags, so "a < b" in prose survives.
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>|<[!?][^<>]*>/gi;
const LEADING_TAG = /^\s*<(?:[a-z][a-z0-9-]*|!--)/i;
// Formatting tags that RSS titles carry in CDATA. Any other tag-shaped text, such as
// "<canvas>" in "Why <canvas> matters", is more likely an escaped tag name and stays.
const INLINE_TAG = /<\/?(?:b|i|em|strong|u|s|strike|small|big|mark|sub|sup|span|font|a|abbr|cite|q|br)\b[^<>]*>/gi;

const MARKDOWN_HEADING = /^#{1,6}\s+\S/;
// WordPress appends this footer to every feed entry.
const WORDPRESS_FOOTER = /^The post .+ appeared first on .+$/;
const READ_MORE = /^(?:continue reading|read more)\b/i;
const READ_MORE_MAX_CHARS = 40;
const MIN_FRAGMENT_CHARS = 20;

export function htmlToText(html: string, maxChars: number): string {
  const raw = html.replace(CONTROL_CHARS, "");
  let text = toText(raw);
  // GitHub's Atom feeds escape the HTML twice: no real tags, but the decoded text starts as
  // HTML. Unwrap one more level at most. Escaped tags next to real ones are literal text.
  if (!hasTag(raw) && LEADING_TAG.test(text)) text = toText(text);
  return fitLines(toLines(text), maxChars);
}

/** One line of plain text from HTML, without the double-escaping unwrap of htmlToText. */
export function htmlToLine(html: string): string {
  return oneLine(toText(html.replace(CONTROL_CHARS, "")));
}

/** One line of plain text from HTML whose only markup is formatting tags. */
export function inlineHtmlToLine(html: string): string {
  const stripped = html.replace(INLINE_TAG, (tag) => (/^<\/?br\b/i.test(tag) ? " " : ""));
  return oneLine(decodeHTML(stripped).replace(CONTROL_CHARS, ""));
}

/** Literal text, normalized and cut like an HTML body. */
export function plainTextToText(text: string, maxChars: number): string {
  return fitLines(toLines(text.replace(CONTROL_CHARS, "")), maxChars);
}

function oneLine(text: string): string {
  return text.replace(MARKER_CHARS, "").replace(/\s+/g, " ").trim();
}

// Cuts by code point so emoji and CJK are never split mid-character.
export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
}

function toText(html: string): string {
  const stripped = dropHidden(html)
    // One line per heading, even when pretty-printed across several.
    .replace(HEADING_ELEMENT, (_, inner: string) => `\n${HEADING}${inner.replace(BLOCK_TAG, " ").replace(/\s+/g, " ")}\n`)
    // Code comments such as "# install" are not Markdown headings.
    .replace(PRE_ELEMENT, (_, inner: string) => {
      const lines = inner.replace(BLOCK_TAG, "\n").split("\n");
      return `\n${lines.map((l) => CODE + l).join("\n")}\n`;
    })
    .replace(HEADING_OPEN, `\n${HEADING}`)
    .replace(BLOCK_TAG, "\n")
    .replace(CELL_TAG, " ")
    .replace(TAG, "");
  // Decode around the markers so "&#1;" cannot forge one.
  return stripped
    .split(MARKERS)
    .map((part, i) => (i % 2 ? part : decodeHTML(part).replace(CONTROL_CHARS, "")))
    .join("");
}

// Drops comments and dropped elements, counting nested elements of the same name. An
// unclosed comment or element runs to the end, so nothing inside it leaks.
function dropHidden(html: string): string {
  let out = "";
  let kept = 0; // html[kept..] is not yet copied or dropped
  let open = ""; // the outermost dropped element we are inside
  let depth = 0;
  HIDDEN.lastIndex = 0;
  for (let m = HIDDEN.exec(html); m; m = HIDDEN.exec(html)) {
    const [, slash, tag, attrs = "", gt] = m;
    const name = tag?.toLowerCase();
    const rawTextEnd = name === undefined ? undefined : RAW_TEXT_END[name];
    if (name === undefined) {
      HIDDEN.lastIndex = skipPast(html, COMMENT_END, HIDDEN.lastIndex);
    } else if (slash) {
      // A stray end tag, or one of another name inside, is left for TAG.
      if (name !== open || --depth > 0) continue;
      open = "";
      kept = HIDDEN.lastIndex;
      continue;
    } else if (!gt || SELF_CLOSING.test(attrs)) {
      // An unclosed start tag already reaches the end, and a self-closed one is empty.
    } else if (rawTextEnd) {
      HIDDEN.lastIndex = skipPast(html, rawTextEnd, HIDDEN.lastIndex);
    } else {
      if (depth === 0) {
        out += html.slice(kept, m.index);
        open = name;
      }
      if (name === open) depth++;
      continue;
    }
    // Inside an open element, comments and raw text are only skipped.
    if (depth === 0) {
      out += html.slice(kept, m.index);
      kept = HIDDEN.lastIndex;
    }
  }
  return depth > 0 ? out : out + html.slice(kept);
}

function skipPast(html: string, end: RegExp, from: number): number {
  end.lastIndex = from;
  return end.exec(html) ? end.lastIndex : html.length;
}

function hasTag(text: string): boolean {
  TAG.lastIndex = 0;
  return TAG.test(text);
}

interface Line {
  text: string;
  heading: boolean;
}

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    const collapsed = raw.replace(/[^\S\n]+/g, " ").trim();
    const line = collapsed.replace(MARKER_CHARS, "").trim();
    const heading = collapsed.includes(HEADING) || (!collapsed.includes(CODE) && MARKDOWN_HEADING.test(line));
    if (line === "" || isBoilerplate(line)) continue;
    lines.push({ text: line, heading });
  }
  return lines;
}

function isBoilerplate(line: string): boolean {
  return WORDPRESS_FOOTER.test(line) || (READ_MORE.test(line) && codePoints(line) < READ_MORE_MAX_CHARS);
}

interface Ranked {
  text: string;
  len: number;
  pos: number;
  cut?: boolean;
}

// Over budget, keep every heading, then the first line of every section, then the second,
// and so on, so a long preamble or PR list cannot crowd out "Breaking Changes".
function fitLines(lines: Line[], maxChars: number): string {
  const joined = lines.map((l) => l.text).join("\n");
  if (codePoints(joined) <= maxChars) return joined;
  if (!lines.some((l) => l.heading) || maxChars < MIN_FRAGMENT_CHARS * 2) return truncate(joined, maxChars);

  // rounds[0] holds the headings, rounds[n] the n-th line of each section.
  const rounds: Ranked[][] = [];
  let rank = 0;
  lines.forEach((line, pos) => {
    rank = line.heading ? 0 : rank + 1;
    (rounds[rank] ??= []).push({ text: line.text, len: codePoints(line.text), pos });
  });

  // Each line costs its length plus one separator, so `used` + 1 leaves room for "\n…".
  const budget = maxChars - 1;
  const picked: Ranked[] = [];
  let used = 0;
  for (const round of rounds) {
    if (!round) continue;
    const cost = round.reduce((n, l) => n + l.len + 1, 0);
    if (used + cost > budget) {
      picked.push(...shareRoom(round, budget - used));
      break;
    }
    picked.push(...round);
    used += cost;
  }

  picked.sort((a, b) => a.pos - b.pos);
  const out = picked.map((p) => p.text).join("\n");
  // Lines were dropped to get here, so mark it unless the last line already shows a cut.
  return picked.at(-1)?.cut ? out : `${out}\n…`;
}

// Splits the room evenly across the round's lines (earliest first), letting short lines
// hand their unused share to longer ones.
function shareRoom(round: Ranked[], room: number): Ranked[] {
  const count = Math.min(round.length, Math.floor(room / (MIN_FRAGMENT_CHARS + 1)));
  const taken = round.slice(0, count).sort((a, b) => a.len - b.len);
  let left = room;
  return taken.map((line, i) => {
    const share = Math.min(line.len + 1, Math.floor(left / (taken.length - i)));
    const text = truncate(line.text, share - 1);
    left -= codePoints(text) + 1;
    return { ...line, text, cut: text !== line.text };
  });
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
