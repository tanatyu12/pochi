// Types for the parts of pochi-tasks.mjs that tests import. The script itself stays plain
// JavaScript so the plugin runs on Node with no build step.

export type CalendarEntry = { Minute?: number; Hour?: number; Day?: number; Weekday?: number; Month?: number };
export function shiftCalendar(entries: CalendarEntry[], minutes: number): CalendarEntry[];

export type Insight = {
  id: string;
  report: string;
  impact: string;
  category?: string;
  title?: string;
  source?: string;
  url?: string;
  [key: string]: unknown;
};
export type SelectRule = { impact?: string[]; category?: string[] };
export function matches(select: SelectRule[], insight: Insight): boolean;
export function pendingInsights(
  all: Insight[],
  state: { items: Record<string, unknown> },
  select: SelectRule[],
): { fresh: Insight[]; picked: Insight[] };

export function mdText(v: unknown): string;
export function mdLink(text: unknown, url: unknown): string;
export function issueParts(
  cfg: { labels: { base: string } },
  f: Insight,
  out: { body: string; kind?: string },
): { labels: string[]; body: string };

export function coveringIssue(
  out: { decision: string; coveredBy?: number },
  known: { number: number | null }[],
): number | undefined;
export function skipComment(f: Insight, out: { reason: string }): string;

export interface ReportInsight {
  id: string;
  title: string;
  url: string;
  impact: "High" | "Medium" | "Low";
  category?: string;
  summary: string;
  action: string;
  source: string;
  publishedAt?: string;
  related: { id: string; title: string; url: string; source: string }[];
}
export function unescapeMarkdown(s: string): string;
export function normalizeUrl(raw: string): string | undefined;
export function importedId(url: string): string;
export function parseMarkdownReport(md: string): { project: string; insights: ReportInsight[] };
export const IMPORT_MIN_AGE_MS: number;
export function importMarkdown(
  cfg: { reportsDir: string; issue: { model?: string; timeoutMinutes?: number } },
  opts: { dryRun?: boolean; now?: number },
): Promise<void>;
export function compareReports(a: string, b: string): number;
export function escapeUntrusted(s: unknown): string;
export function categoryPrompt(items: { id: string; title?: string; summary?: string; action?: string }[]): string;
export function issueInput(
  cfg: { language: string },
  f: Insight,
  known: { number: number | null; title: string }[],
): { language: string; insight: Insight; openIssues: { number: number | null; title: string }[] };
export function sameCalendar(a: CalendarEntry[], b: CalendarEntry[]): boolean;
export function trustedComments<C extends { author?: { login?: string } | null }>(comments: C[] | undefined, allowed: string[]): C[];
export function withLock<T>(path: string, fn: () => Promise<T>): Promise<T | undefined>;
export function shell(command: string, cwd: string, timeoutMs?: number, graceMs?: number): Promise<{ ok: boolean; tail: string }>;
export function readReports(dir: string, sinceDate?: string): Promise<(ReportInsight & { report: string; project: string })[]>;
