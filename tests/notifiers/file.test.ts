import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileNotifier } from "../../src/notifiers/file.js";
import { escapeMarkdown, toMarkdown, toText } from "../../src/notifiers/text.js";
import type { Briefing } from "../../src/notifiers/types.js";
import type { Insight, Item } from "../../src/types.js";
import { configureLog, resetLog } from "../../src/util/log.js";

const fsMock = vi.hoisted(() => ({ linkError: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (fsMock.linkError) throw Object.assign(new Error(fsMock.linkError), { code: fsMock.linkError });
      return actual.link(from, to);
    },
  };
});

function insight(n: number, overrides: Partial<Omit<Insight, "item">> & { url?: string } = {}): Insight {
  const { url, ...rest } = overrides;
  return {
    item: {
      id: `id${n}`,
      sourceId: "nextjs",
      sourceName: "Next.js releases",
      kind: "github",
      title: `Original ${n}`,
      url: url ?? `https://example.com/posts/${n}`,
      urlKey: `key${n}`,
      content: "",
    },
    title: `Title ${n}`,
    summary: `Summary ${n}`,
    impact: "Medium",
    action: `Action ${n}`,
    ...rest,
  };
}

function briefing(insights: Insight[], overrides: Partial<Briefing> = {}): Briefing {
  return { project: "my-app", date: "2026-10-26", insights, collected: 120, attempted: 8, failedSources: [], ...overrides };
}

let dir: string;
let logs: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pochi-file-"));
  logs = "";
  configureLog({ write: (s) => (logs += s) });
});

afterEach(async () => {
  fsMock.linkError = undefined;
  resetLog();
  await rm(dir, { recursive: true, force: true });
});

describe("toMarkdown", () => {
  it("renders each insight under its own heading", () => {
    const b = briefing([insight(1, { impact: "High" }), insight(2, { summary: "", action: "" })], {
      failedSources: ["Blog A"],
    });
    expect(toMarkdown(b)).toMatchSnapshot();
  });

  it("escapes markup that comes from feeds and the model", () => {
    const md = toMarkdown(
      briefing([
        insight(1, {
          title: "# Big [news](https://evil.example) <script>",
          summary: "*bold* `code`",
          url: "https://example.com/a (1)>x",
        }),
      ]),
    );
    expect(md).toContain("## [Medium] [\\# Big \\[news\\](https://evil.example) \\<script\\>](<https://example.com/a (1)%3Ex>)");
    expect(md).toContain("\\*bold\\* \\`code\\`");
  });

  it("keeps a multi-line summary on one line, so it cannot become a rule or a list", () => {
    const md = toMarkdown(briefing([insight(1, { summary: "First\n---\n- item", action: "Do\n\n1. this" })]));
    expect(md).toContain("\n\nFirst --- - item\n\n**Action:** Do 1. this\n");
  });

  it("escapes a list item, rule or code fence at the start of a line", () => {
    const md = toMarkdown(
      briefing([
        insight(1, { summary: "- not a list", action: "1. not a list" }),
        insight(2, { summary: "---", action: "+ x" }),
        insight(3, { summary: "~~~ not code", action: "2) no" }),
      ]),
    );
    expect(md).toContain("\n\n\\- not a list\n\n**Action:** 1\\. not a list\n");
    expect(md).toContain("\n\n\\---\n\n**Action:** \\+ x\n");
    expect(md).toContain("\n\n\\~~~ not code\n\n**Action:** 2\\) no\n");
    expect(escapeMarkdown("a - b 1. c")).toBe("a - b 1. c");
  });

  it("says so when nothing is relevant", () => {
    expect(toMarkdown(briefing([]))).toContain("No relevant updates today.");
  });
});

describe("toText", () => {
  it("drops control characters from feed and model text, keeping the layout", () => {
    const evil = insight(1, {
      title: "Title\u001b]8;;https://evil.example\u0007",
      summary: "Sum\u009bmary",
      action: "Act\u0007ion",
    });
    evil.item.sourceName = "Blog\u001b[31m";
    const related: Item = { ...evil.item, id: "r1", title: "Also\u001b[0m" };
    const text = toText(briefing([{ ...evil, related: [related] }]));
    expect(text).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(text).toContain("[Medium] Title]8;;https://evil.example\n");
    expect(text).toContain("  Summary\n  Action: Action\n  Source: Blog[31m\n  Also: Also[0m ");
  });
});

describe("other reports of a story", () => {
  const report = (n: number): Item => ({
    ...insight(n).item,
    id: `r${n}`,
    title: `Report *${n}*`,
    url: `https://news.example.com/${n}`,
  });
  const story = (count: number) => insight(1, { related: Array.from({ length: count }, (_, i) => report(i + 1)) });

  it("lists up to three in the report and counts the rest", () => {
    const md = toMarkdown(briefing([story(5)]));
    expect(md).toContain(
      "Also: [Report \\*1\\*](<https://news.example.com/1>) · [Report \\*2\\*](<https://news.example.com/2>) · [Report \\*3\\*](<https://news.example.com/3>) · and 2 more",
    );
    expect(toMarkdown(briefing([insight(1)]))).not.toContain("Also:");
  });

  it("lists them in the dry run's text", () => {
    const text = toText(briefing([story(4)]));
    expect(text).toContain("  Also: Report *1* https://news.example.com/1\n");
    expect(text).toContain("  Also: 1 more article\n");
  });
});

describe("fileNotifier", () => {
  it("writes <date>.md and reports every insight delivered", async () => {
    const result = await fileNotifier({ dir, postWhenEmpty: false }).deliver(briefing([insight(1), insight(2)]), {});
    expect(result).toEqual({ deliveredIds: ["id1", "id2"], failures: [], aborted: false });
    expect(await readFile(join(dir, "2026-10-26.md"), "utf8")).toBe(toMarkdown(briefing([insight(1), insight(2)])));
    expect(logs).toContain("2026-10-26.md");
  });

  it("writes the report readable by the owner only", async () => {
    await fileNotifier({ dir, postWhenEmpty: false }).deliver(briefing([insight(1)]), {});
    const { mode } = await stat(join(dir, "2026-10-26.md"));
    if (process.platform !== "win32") expect(mode & 0o777).toBe(0o600);
  });

  it("writes the report owner-only also without hard links", async () => {
    fsMock.linkError = "EPERM";
    await fileNotifier({ dir, postWhenEmpty: false }).deliver(briefing([insight(1)]), {});
    const { mode } = await stat(join(dir, "2026-10-26.md"));
    if (process.platform !== "win32") expect(mode & 0o777).toBe(0o600);
  });

  it("creates the directory and never overwrites an earlier report", async () => {
    const nested = join(dir, "a", "b");
    const notifier = fileNotifier({ dir: nested, postWhenEmpty: false });
    await notifier.deliver(briefing([insight(1)]), {});
    await notifier.deliver(briefing([insight(2)]), {});
    await notifier.deliver(briefing([insight(3)]), {});
    expect((await readdir(nested)).sort()).toEqual(["2026-10-26-2.md", "2026-10-26-3.md", "2026-10-26.md"]);
    expect(await readFile(join(nested, "2026-10-26.md"), "utf8")).toContain("Title 1");
    expect(await readFile(join(nested, "2026-10-26-3.md"), "utf8")).toContain("Title 3");
  });

  it("falls back to an exclusive write where hard links are not supported", async () => {
    fsMock.linkError = "EPERM";
    const notifier = fileNotifier({ dir, postWhenEmpty: false });
    expect((await notifier.deliver(briefing([insight(1)]), {})).deliveredIds).toEqual(["id1"]);
    expect((await notifier.deliver(briefing([insight(2)]), {})).deliveredIds).toEqual(["id2"]);
    expect((await readdir(dir)).sort()).toEqual(["2026-10-26-2.md", "2026-10-26.md"]);
    expect(await readFile(join(dir, "2026-10-26.md"), "utf8")).toContain("Title 1");
  });

  it("writes nothing for no insights unless postWhenEmpty is on", async () => {
    expect(await fileNotifier({ dir, postWhenEmpty: false }).deliver(briefing([]), {})).toEqual({
      deliveredIds: [],
      failures: [],
      aborted: false,
    });
    expect(await readdir(dir)).toEqual([]);
    await fileNotifier({ dir, postWhenEmpty: true }).deliver(briefing([]), {});
    expect(await readdir(dir)).toEqual(["2026-10-26.md"]);
  });

  it("reports every insight as failed when the file cannot be written", async () => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    const result = await fileNotifier({ dir: blocker, postWhenEmpty: false }).deliver(briefing([insight(1)]), {});
    expect(result.deliveredIds).toEqual([]);
    expect(result.failures.map((f) => f.itemIds)).toEqual([["id1"]]);
    expect(logs).toContain("the report was not written");
  });
});
