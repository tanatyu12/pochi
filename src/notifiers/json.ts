import type { Insight } from "../types.js";
import type { Briefing } from "./types.js";

/** One insight as run --json and the file channel's json report print it. */
export function insightJson(f: Insight) {
  return {
    id: f.item.id,
    title: f.title,
    url: f.item.url,
    impact: f.impact,
    ...(f.category && { category: f.category }),
    summary: f.summary,
    action: f.action,
    source: f.item.sourceName,
    publishedAt: f.item.publishedAt,
    related: (f.related ?? []).map((r) => ({ id: r.id, title: r.title, url: r.url, source: r.sourceName })),
  };
}

/**
 * What the file channel writes as <date>.json: the report in a form scripts can read without
 * parsing Markdown. Text is left as the feeds and the model gave it; readers escape what they show.
 */
export function toReportJson(b: Briefing): string {
  return `${JSON.stringify(
    {
      pochi: "report/v1",
      project: b.project,
      date: b.date,
      collected: b.collected,
      attempted: b.attempted,
      failedSources: b.failedSources,
      insights: b.insights.map(insightJson),
    },
    null,
    2,
  )}\n`;
}
