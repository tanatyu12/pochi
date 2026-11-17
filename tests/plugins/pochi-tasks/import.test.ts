import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMPORT_MIN_AGE_MS,
  importMarkdown,
  importedId,
  normalizeUrl as pluginNormalizeUrl,
  parseMarkdownReport,
  readReports,
} from "../../../plugins/pochi-tasks/scripts/pochi-tasks.mjs";
import { insightJson } from "../../../src/notifiers/json.js";
import { MAX_RELATED_SHOWN, toMarkdown } from "../../../src/notifiers/text.js";
import type { Briefing } from "../../../src/notifiers/types.js";
import type { Insight, Item } from "../../../src/types.js";
import { normalizeUrl, urlKey } from "../../../src/util/hash.js";

function item(n: number, overrides: Partial<Item> = {}): Item {
  return {
    id: `id${n}`,
    sourceId: "nextjs",
    sourceName: "Next.js releases",
    kind: "github",
    title: `Original ${n}`,
    url: `https://example.com/posts/${n}`,
    urlKey: `key${n}`,
    content: "",
    ...overrides,
  };
}

function insight(n: number, overrides: Partial<Omit<Insight, "item">> & { item?: Partial<Item> } = {}): Insight {
  const { item: itemOverrides, ...rest } = overrides;
  return { item: item(n, itemOverrides), title: `Title ${n}`, summary: `Summary ${n}`, impact: "Medium", category: "tech", action: `Action ${n}`, ...rest };
}

function briefing(insights: Insight[], overrides: Partial<Briefing> = {}): Briefing {
  return { project: "my-app", date: "2026-10-26", insights, collected: 120, attempted: 8, failedSources: [], ...overrides };
}

/** What the json report would hold for f, with the id an import gives it. */
function expected(f: Insight) {
  const { publishedAt: _, ...j } = insightJson(f);
  return {
    ...j,
    id: urlKey(normalizeUrl(f.item.url)!),
    // Only the related reports the Markdown shows can come back from it.
    related: j.related.slice(0, MAX_RELATED_SHOWN).map((r) => ({ ...r, id: urlKey(normalizeUrl(r.url)!), source: "" })),
  };
}

describe("parseMarkdownReport", () => {
  it("does read back every field Pochi's Markdown report renders", () => {
    const fs = [
      insight(1, { impact: "High", related: [item(5, { title: "Other [5]" }), item(6), item(7), item(8)] }),
      insight(2, { category: undefined }),
    ];
    const parsed = parseMarkdownReport(toMarkdown(briefing(fs, { failedSources: ["Blog A"] })));
    expect(parsed.project).toBe("my-app");
    expect(parsed.insights).toEqual(fs.map(expected));
  });

  it("does stop the summary before Source when the Action is empty", () => {
    const parsed = parseMarkdownReport(toMarkdown(briefing([insight(1, { action: "" }), insight(2, { action: "" })])));
    expect(parsed.insights.map((i) => [i.summary, i.action, i.source])).toEqual([
      ["Summary 1", "", "Next.js releases"],
      ["Summary 2", "", "Next.js releases"],
    ]);
  });

  it("does leave the report footer out of the last insight", () => {
    const parsed = parseMarkdownReport(toMarkdown(briefing([insight(1, { summary: "", action: "" })], { failedSources: ["Blog A"] })));
    expect(parsed.insights[0]).toMatchObject({ summary: "", action: "", source: "Next.js releases" });
  });

  it("does undo Pochi's Markdown escaping", () => {
    const text = "- *a* _b_ `c` [d](e) <f> #g \\h ~i +j";
    const f = insight(1, {
      title: `[x] ${text}`,
      summary: "1. Source: not a source line",
      action: "**bold** 2) done",
      item: { sourceName: "Blog #1 <x>" },
    });
    const parsed = parseMarkdownReport(toMarkdown(briefing([f], { project: "a_b · c" })));
    expect(parsed.project).toBe("a_b · c");
    expect(parsed.insights[0]).toMatchObject({ title: `[x] ${text}`, summary: "1. Source: not a source line", action: "**bold** 2) done", source: "Blog #1 <x>" });
  });

  it("does read a summary that starts like a Source line", () => {
    const parsed = parseMarkdownReport(toMarkdown(briefing([insight(1, { summary: "Source: the vendor", action: "" })])));
    expect(parsed.insights[0]).toMatchObject({ summary: "Source: the vendor", source: "Next.js releases" });
  });
});

describe("importedId", () => {
  it("does match Pochi's urlKey of the normalized URL", () => {
    for (const url of [
      "https://example.com/posts/1",
      "https://example.com/a/?utm_source=x&b=1&fbclid=2#top",
      "https://example.com/#/news/1",
      "http://EXAMPLE.com:80/a%20b//",
      "https://example.com/?q=a+b&GCLID=1",
    ]) {
      expect(pluginNormalizeUrl(url)).toBe(normalizeUrl(url));
      expect(importedId(url)).toBe(urlKey(normalizeUrl(url)!));
    }
  });
});

describe("importMarkdown and readReports", () => {
  let dir: string;
  let stderr: string;
  const cfg = () => ({ reportsDir: dir, issue: {} });
  const old = (Date.now() - IMPORT_MIN_AGE_MS - 60_000) / 1000;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pochi-tasks-import-"));
    stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr += String(s);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeMd(name: string, b: Briefing, mtime = old) {
    await writeFile(join(dir, name), toMarkdown(b));
    await utimes(join(dir, name), mtime, mtime);
  }

  it("does import an old Markdown report and leave no temporary file", async () => {
    await writeMd("2026-10-26.md", briefing([insight(1)]));
    await importMarkdown(cfg(), {});
    expect((await readdir(dir)).sort()).toEqual(["2026-10-26.json", "2026-10-26.md"]);
    const report = JSON.parse(await readFile(join(dir, "2026-10-26.json"), "utf8"));
    expect(report).toMatchObject({ pochi: "report/v1", project: "my-app", date: "2026-10-26", importedFrom: "2026-10-26.md" });
    expect(await readReports(dir)).toEqual([{ ...expected(insight(1)), report: "2026-10-26.json", project: "my-app" }]);
  });

  it("does not import a Markdown report written moments ago, whose json may still be coming", async () => {
    await writeMd("2026-10-26.md", briefing([insight(1)]), Date.now() / 1000);
    await importMarkdown(cfg(), {});
    expect(await readdir(dir)).toEqual(["2026-10-26.md"]);
    expect(stderr).toContain("2026-10-26.md was just written");
  });

  it("does keep a json report that already exists", async () => {
    await writeMd("2026-10-26.md", briefing([insight(1)]));
    await writeFile(join(dir, "2026-10-26.json"), "{}");
    await importMarkdown(cfg(), {});
    expect(await readFile(join(dir, "2026-10-26.json"), "utf8")).toBe("{}");
  });

  it("does skip a truncated json report with a warning instead of throwing", async () => {
    await writeFile(join(dir, "2026-10-25.json"), '{"pochi": "report/v1", "insi');
    await writeMd("2026-10-26.md", briefing([insight(1)]));
    await importMarkdown(cfg(), {});
    const all = await readReports(dir);
    expect(all.map((f) => f.report)).toEqual(["2026-10-26.json"]);
    expect(stderr).toContain("skipping 2026-10-25.json");
  });
});
