import type { Insight } from "../types.js";
import { collapseWhitespace, plural } from "../util/text.js";
import type { Briefing } from "./types.js";

/** What a dry run prints: plain text for a terminal. */
export function toText(b: Briefing): string {
  const head = `Pochi · ${b.project} · ${b.date}\n`;
  const foot = `\n${b.collected} items from ${b.attempted} sources` + failedText(b) + "\n";
  if (b.insights.length === 0) return `${head}\nNo relevant updates.\n${foot}`;
  const body = b.insights.map((f) =>
    [
      `[${f.impact}] ${f.title}`,
      `  ${f.item.url}`,
      ...(f.summary ? [`  ${f.summary}`] : []),
      ...(f.action ? [`  Action: ${f.action}`] : []),
      `  Source: ${f.item.sourceName}`,
    ].join("\n"),
  );
  return `${head}\n${body.join("\n\n")}\n${foot}`;
}

/**
 * What the file channel writes. Titles, summaries and source names come from feeds and the model,
 * so they are escaped: a heading or link in them cannot change the report's structure.
 */
export function toMarkdown(b: Briefing): string {
  const head = `# Pochi · ${escapeMarkdown(b.project)} · ${b.date}\n`;
  const foot =
    `\n---\n\nCollected ${plural(b.collected, "item")} from ${plural(b.attempted, "source")}` +
    failedText(b, escapeMarkdown) +
    "\n";
  if (b.insights.length === 0) return `${head}\nNo relevant updates today.\n${foot}`;
  return `${head}\n${b.insights.map(insightMarkdown).join("\n\n")}\n${foot}`;
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
  ].join("\n");
}

function failedText(b: Briefing, escape = (s: string) => s): string {
  return b.failedSources.length > 0 ? `; failed: ${escape(b.failedSources.join(", "))}` : "";
}

/**
 * Backslash-escapes what would start emphasis, code, a link, inline HTML or a heading. Kept to
 * these so the file still reads well as plain text.
 */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_[\]<>#]/g, "\\$&");
}
