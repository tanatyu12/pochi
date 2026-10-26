/** Every run of whitespace, newlines included, becomes one space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Cuts by code point so emoji and CJK are never split mid-character.
export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
}
