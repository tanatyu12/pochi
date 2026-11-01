import type { Insight, Item } from "../types.js";
import { collapseWhitespace, plural, stripControlChars } from "../util/text.js";
import type { Briefing } from "./types.js";
import { failedLabel, fetchedText, quietLine } from "./voice.js";

/** Other reports of a story shown with it; the rest are only counted. */
export const MAX_RELATED_SHOWN = 3;

/** The other reports of a story to list, and how many more there are. */
export function relatedShown(f: Insight): { shown: Item[]; more: number } {
  const related = f.related ?? [];
  return { shown: related.slice(0, MAX_RELATED_SHOWN), more: Math.max(0, related.length - MAX_RELATED_SHOWN) };
}

/**
 * What a dry run prints: plain text for a terminal. Titles, summaries and source names come
 * from feeds and the model, so control characters are dropped: no escape sequence reaches the
 * terminal. Tabs and newlines stay.
 */
export function toText(b: Briefing): string {
  return stripControlChars(renderText(b));
}

function renderText(b: Briefing): string {
  const head = `Pochi · ${b.project} · ${b.date}\n`;
  const counts = b.personality ? fetchedText(b) : `${b.collected} items from ${b.attempted} sources`;
  const foot = `\n${counts}` + failedText(b) + "\n";
  if (b.insights.length === 0) return `${head}\n${quietLine(b) ?? "No relevant updates."}\n${foot}`;
  const body = b.insights.map((f) =>
    [
      `[${f.impact}] ${f.title}`,
      `  ${f.item.url}`,
      ...(f.summary ? [`  ${f.summary}`] : []),
      ...(f.action ? [`  Action: ${f.action}`] : []),
      `  Source: ${f.item.sourceName}`,
      ...relatedText(f),
    ].join("\n"),
  );
  return `${head}\n${body.join("\n\n")}\n${foot}`;
}

/**
 * What the file channel writes. Titles, summaries and source names come from feeds and the model,
 * so they are escaped: a heading or link in them cannot change the report's structure. Control
 * characters are dropped as in toText, since the report may well be read with cat.
 */
export function toMarkdown(b: Briefing): string {
  return stripControlChars(renderMarkdown(b));
}

function renderMarkdown(b: Briefing): string {
  const head = `# Pochi · ${escapeMarkdown(b.project)} · ${b.date}\n`;
  const foot = `\n---\n\n${fetchedText(b)}` + failedText(b, escapeMarkdown) + "\n";
  if (b.insights.length === 0) return `${head}\n${quietLine(b) ?? "No relevant updates today."}\n${foot}`;
  return `${head}\n${b.insights.map(insightMarkdown).join("\n\n")}\n${foot}`;
}

function relatedText(f: Insight): string[] {
  const { shown, more } = relatedShown(f);
  return [
    ...shown.map((r) => `  Also: ${collapseWhitespace(r.title)} ${r.url}`),
    ...(more > 0 ? [`  Also: ${plural(more, "more article")}`] : []),
  ];
}

function relatedMarkdown(f: Insight): string[] {
  const { shown, more } = relatedShown(f);
  if (shown.length === 0) return [];
  const links = shown.map((r) => `[${escapeMarkdown(collapseWhitespace(r.title))}](<${r.url.replaceAll(">", "%3E")}>)`);
  return ["", `Also: ${[...links, ...(more > 0 ? [`and ${more} more`] : [])].join(" · ")}`];
}

function insightMarkdown(f: Insight): string {
  // One line each: a line of its own such as "---" or "- x" would become a rule or a list.
  const [title, summary, action] = [f.title, f.summary, f.action].map((s) => escapeMarkdown(collapseWhitespace(s)));
  return [
    // <...> keeps parentheses and spaces in the URL from ending the link.
    `## [${f.impact}] [${title}](<${f.item.url.replaceAll(">", "%3E")}>)`,
    ...(summary ? ["", summary] : []),
    ...(action ? ["", `**Action:** ${action}`] : []),
    "",
    `Source: ${escapeMarkdown(collapseWhitespace(f.item.sourceName))}`,
    ...relatedMarkdown(f),
  ].join("\n");
}

function failedText(b: Briefing, escape = (s: string) => s): string {
  return b.failedSources.length > 0 ? `; ${failedLabel(b)}: ${escape(b.failedSources.join(", "))}` : "";
}

/**
 * Backslash-escapes what would start emphasis, code, a link, inline HTML or a heading, and a
 * line-leading list item, rule or code fence ("- ", "+ ", "1. ", "---", "~~~"). Kept to these
 * so the file still reads well as plain text.
 */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/[\\`*_[\]<>#]/g, "\\$&")
    .replace(/^([ \t]*)([-+~])/gm, "$1\\$2")
    .replace(/^([ \t]*\d+)([.)])/gm, "$1\\$2");
}
