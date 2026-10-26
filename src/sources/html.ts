import { decodeHTML } from "entities";

// Marks the start of a heading line between passes. Input control characters are stripped
// first, so it can only come from us.
const HEADING = "\u0001";
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const DROPPED_ELEMENTS =
  /<(script|style|noscript|template|svg|iframe|head|nav|header|footer|aside|form)\b(?:[^>]*\/>|[^>]*(?:>[\s\S]*?(?:<\/\1\s*>|$)|$))/gi;
// An unclosed comment or element runs to the end, so nothing inside it leaks.
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const HEADING_OPEN = /<h[1-6]\b[^>]*>/gi;
const BLOCK_TAG =
  /<\/?(?:p|div|br|li|dt|dd|tr|blockquote|pre|ul|ol|dl|table|section|article|main|figcaption|hr|h[1-6])\b[^>]*>/gi;
const CELL_TAG = /<\/?t[dh]\b[^>]*>/gi;
// Only things shaped like tags, so "a < b" in prose survives.
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>|<[!?][^<>]*>/gi;

const MARKDOWN_HEADING = /^#{1,6}\s+\S/;
// WordPress appends this footer to every feed entry.
const WORDPRESS_FOOTER = /^The post .+ appeared first on .+$/;
const READ_MORE = /^(?:continue reading|read more)\b/i;
const READ_MORE_MAX_CHARS = 40;
const MIN_FRAGMENT_CHARS = 20;

export function htmlToText(html: string, maxChars: number): string {
  let text = toText(html.replace(CONTROL_CHARS, ""));
  // GitHub's Atom feeds escape the HTML twice. Unwrap one more level at most.
  if (hasTag(text)) text = toText(text);
  return fitLines(toLines(text), maxChars);
}

// Cuts by code point so emoji and CJK are never split mid-character.
export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
}

function toText(html: string): string {
  const stripped = html
    .replace(COMMENT, "")
    .replace(DROPPED_ELEMENTS, "")
    .replace(HEADING_OPEN, `\n${HEADING}`)
    .replace(BLOCK_TAG, "\n")
    .replace(CELL_TAG, " ")
    .replace(TAG, "");
  // Decode around the markers so "&#1;" cannot forge one.
  return stripped
    .split(HEADING)
    .map((part) => decodeHTML(part).replace(CONTROL_CHARS, ""))
    .join(HEADING);
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
    const heading = collapsed.startsWith(HEADING) || MARKDOWN_HEADING.test(collapsed);
    const line = collapsed.replaceAll(HEADING, "").trim();
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

  const out = picked
    .sort((a, b) => a.pos - b.pos)
    .map((p) => p.text)
    .join("\n");
  return out.endsWith("…") ? out : `${out}\n…`;
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
    return { ...line, text };
  });
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
