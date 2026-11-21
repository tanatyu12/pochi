import { describe, expect, it } from "vitest";
import { insightJson, toReportJson } from "../../src/notifiers/json.js";
import type { Briefing } from "../../src/notifiers/types.js";
import type { Insight } from "../../src/types.js";

function insight(n: number, overrides: Partial<Omit<Insight, "item">> = {}): Insight {
  return {
    item: {
      id: `id${n}`,
      sourceId: "nextjs",
      sourceName: "Next.js releases",
      kind: "github",
      title: `Original ${n}`,
      url: `https://example.com/posts/${n}`,
      urlKey: `key${n}`,
      content: "",
      publishedAt: "2026-10-25T09:00:00.000Z",
    },
    title: `Title ${n}`,
    summary: `Summary ${n}`,
    impact: "Medium",
    action: `Action ${n}`,
    ...overrides,
  };
}

function briefing(insights: Insight[]): Briefing {
  return { project: "my-app", date: "2026-10-26", insights, collected: 120, attempted: 8, failedSources: ["Broken feed"] };
}

describe("toReportJson", () => {
  it("does write the report/v1 document", () => {
    const related = [insight(3).item];
    const b = briefing([insight(1, { impact: "High", category: "tech", related }), insight(2)]);
    expect(toReportJson(b)).toMatchSnapshot();
  });

  it("does end with a newline and parse back as JSON", () => {
    const text = toReportJson(briefing([]));
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ pochi: "report/v1", insights: [] });
  });
});

describe("insightJson", () => {
  it("does leave out category when the insight has none", () => {
    expect(insightJson(insight(1))).not.toHaveProperty("category");
    expect(insightJson(insight(1, { category: "ops" }))).toHaveProperty("category", "ops");
  });

  it("does keep text as the feed and the model gave it", () => {
    expect(insightJson(insight(1, { title: "<b>a & b</b>" })).title).toBe("<b>a & b</b>");
  });
});
