import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileNotifier } from "../../src/notifiers/file.js";
import { toMarkdown } from "../../src/notifiers/text.js";
import type { Briefing } from "../../src/notifiers/types.js";
import type { Insight } from "../../src/types.js";
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

  it("says so when nothing is relevant", () => {
    expect(toMarkdown(briefing([]))).toContain("No relevant updates today.");
  });
});

describe("fileNotifier", () => {
  it("writes <date>.md and reports every insight delivered", async () => {
    const result = await fileNotifier({ dir, postWhenEmpty: false }).deliver(briefing([insight(1), insight(2)]), {});
    expect(result).toEqual({ deliveredIds: ["id1", "id2"], failures: [], aborted: false });
    expect(await readFile(join(dir, "2026-10-26.md"), "utf8")).toBe(toMarkdown(briefing([insight(1), insight(2)])));
    expect(logs).toContain("2026-10-26.md");
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
