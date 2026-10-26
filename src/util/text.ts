/** Every run of whitespace, newlines included, becomes one space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Cuts by code point so emoji and CJK are never split mid-character.
export function truncate(text: string, maxChars: number): string {
  return cut(Array.from(text), maxChars, () => 1);
}

/**
 * Joins units no longer than maxLength in UTF-16 code units, never splitting a unit, with "…"
 * when cut. For text whose pieces must stay whole, such as escaped entities.
 */
export function truncateUnits(units: string[], maxLength: number): string {
  return cut(units, maxLength, (u) => u.length);
}

function cut(units: string[], max: number, size: (unit: string) => number): string {
  if (max <= 0) return "";
  let total = 0;
  for (const u of units) total += size(u);
  if (total <= max) return units.join("");
  let out = "";
  let used = 0;
  for (const u of units) {
    const n = size(u);
    // Room for the "…".
    if (used + n + 1 > max) break;
    out += u;
    used += n;
  }
  return `${out.trimEnd()}…`;
}

/** C0 controls other than tab and newline, DEL and C1, so no ANSI or OSC sequence can survive. */
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/** One line without control characters, for text from outside shown on a terminal. */
export function displayLine(text: string, maxChars: number): string {
  return truncate(collapseWhitespace(stripControlChars(text)), maxChars);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
