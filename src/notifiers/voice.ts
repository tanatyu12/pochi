import { sha256Hex } from "../util/hash.js";
import { plural } from "../util/text.js";
import type { Briefing } from "./types.js";

/**
 * Pochi's lines for a quiet day. Chosen by the date, so a day's reports (and their tests) say
 * the same thing. Nothing in them needs escaping in Markdown or Slack mrkdwn.
 */
export const QUIET_LINES: readonly string[] = [
  "Nothing worth fetching today.",
  "A quiet day. Pochi found nothing that needs you.",
  "All clear. Pochi will keep watch.",
];

/** What a report says when there is nothing to report, or undefined for the plain wording. */
export function quietLine(b: Briefing): string | undefined {
  if (!b.personality) return undefined;
  return QUIET_LINES[Number.parseInt(sha256Hex(b.date).slice(0, 8), 16) % QUIET_LINES.length];
}

const MILESTONES = new Set([10, 50, 100, 200, 300, 365, 500, 1000]);

/** Whether the nth briefing is mentioned in its footer. */
export function isMilestone(n: number): boolean {
  return MILESTONES.has(n);
}

/** The footer's count of what was collected. */
export function fetchedText(b: Briefing): string {
  const counts = `${plural(b.collected, "item")} from ${plural(b.attempted, "source")}`;
  if (!b.personality) return `Collected ${counts}`;
  // Every milestone ends in 0 or 5, so it takes "th".
  return `Fetched by Pochi · ${counts}` + (b.milestone === undefined ? "" : ` · ${b.milestone}th briefing`);
}

/** Leads the list of sources that failed, lowercase. */
export function failedLabel(b: Briefing): string {
  return b.personality ? "couldn't fetch" : "failed";
}
