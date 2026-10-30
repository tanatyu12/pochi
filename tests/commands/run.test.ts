import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunDeps, type RunOptions, runCommand } from "../../src/commands/run.js";
import { ExitCode, exitCodeOf } from "../../src/errors.js";
import type { resolveLlm } from "../../src/llm/adapter.js";
import {
  type AnalysisOutput,
  type GenerateRequest,
  GroupingOutputSchema,
  type GroupingOutput,
  type LlmClient,
  LlmError,
  type TriageOutput,
} from "../../src/llm/schema.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { type FetchMock, mockFetch, type Reply, reply } from "../helpers/mockFetch.js";

const NOW = new Date("2026-10-26T00:00:00Z");
const FEED_A = "https://a.example.com/feed.xml";
const FEED_B = "https://b.example.com/feed.xml";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/s3cr3tW3bh00k";

const CONTEXT = `version: 1
project: { name: my-app, description: "A web app" }
problems: ["keep dependencies current"]
`;

const SOURCES = `version: 1
feeds:
  - { id: a, type: rss, name: "Blog A", url: "${FEED_A}" }
  - { id: b, type: rss, name: "Blog B", url: "${FEED_B}" }
`;

interface Post {
  title: string;
  /** Days before NOW. */
  age?: number;
}

function rss(host: string, posts: Post[]): string {
  const items = posts.map(
    (p, i) => `<item><title>${p.title}</title><link>https://${host}/${i}</link>
      <pubDate>${new Date(NOW.getTime() - (p.age ?? 1) * 86_400_000).toUTCString()}</pubDate>
      <description>About ${p.title}</description></item>`,
  );
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${host}</title>${items.join("")}</channel></rss>`;
}

const feedA = (posts: Post[] = [{ title: "Breaking change in lib" }, { title: "Boring news" }]) =>
  reply.text(rss("a.example.com", posts));
const feedB = (posts: Post[] = [{ title: "Security fix in lib" }]) => reply.text(rss("b.example.com", posts));

interface Call {
  tier: string;
  titles: string[];
}

/** Triage marks everything relevant except titles containing "Boring"; analyze rates all High. */
function fakeLlm(
  over: { analyze?: (ids: string[]) => AnalysisOutput; group?: (titles: string[]) => GroupingOutput } = {},
) {
  const calls: Call[] = [];
  const client: LlmClient = {
    mode: "api",
    async generate<T>(req: GenerateRequest<T>): Promise<T> {
      const ids = [...req.prompt.matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]!);
      const titles = [...req.prompt.matchAll(/^title: (.*)$/gm)].map((m) => m[1]!);
      if ((req.schema as unknown) === GroupingOutputSchema) {
        calls.push({ tier: "group", titles });
        return (over.group?.(titles) ?? { groups: [] }) as T;
      }
      calls.push({ tier: req.tier, titles });
      if (req.tier === "triage") {
        const out: TriageOutput = {
          decisions: ids.map((id, i) => ({ id, relevant: !titles[i]!.includes("Boring"), reason: "" })),
        };
        return out as T;
      }
      const out: AnalysisOutput = over.analyze?.(ids) ?? {
        insights: ids.map((id) => ({ id, title: "", summary: "Read it", impact: "High", action: "Upgrade" })),
      };
      return out as T;
    },
  };
  const resolve: typeof resolveLlm = async () => ({ client, models: { triage: "t", analyze: "a" } });
  return { client, calls, resolve, titles: (tier: string) => calls.filter((c) => c.tier === tier).flatMap((c) => c.titles) };
}

let dir: string;
let statePath: string;
let logs: string;
let stdout: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pochi-run-"));
  statePath = join(dir, "state", "notified.json");
  await mkdir(join(dir, "config"));
  await writeFile(join(dir, "config", "context.yml"), CONTEXT);
  await writeFile(join(dir, "config", "sources.yml"), SOURCES);
  logs = "";
  stdout = "";
  configureLog({ write: (s) => (logs += s) });
  for (const name of ["POCHI_CONTEXT_YAML", "POCHI_SOURCES_YAML", "POCHI_STATE_PATH", "TAVILY_API_KEY", "GITHUB_TOKEN"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK);
});

afterEach(async () => {
  resetLog();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

const withChannels = (channels: string) => `${CONTEXT}notify:\n  channels: ${channels}\n`;

function run(llm: ReturnType<typeof fakeLlm>, opts: RunOptions = {}, deps: RunDeps = {}) {
  return runCommand(
    { configDir: join(dir, "config"), state: statePath, ...opts },
    {
      now: () => NOW,
      timeZone: "UTC",
      stdout: (s) => (stdout += s),
      resolveLlm: llm.resolve,
      retryDelayMs: 0,
      slackIntervalMs: 0,
      ...deps,
    },
  );
}

async function exitOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return ExitCode.OK;
  } catch (err) {
    return exitCodeOf(err);
  }
}

async function readState(): Promise<Record<string, { s: string }>> {
  return JSON.parse(await readFile(statePath, "utf8")).entries;
}

const statuses = async () => Object.values(await readState()).map((e) => e.s).sort();

function slackTexts(fetch: FetchMock): string[] {
  return fetch.callsTo(WEBHOOK).map((c) => JSON.parse(c.body!).text as string);
}

function routes(over: { slack?: Reply | Reply[]; a?: Reply; b?: Reply } = {}) {
  return mockFetch({ [FEED_A]: over.a ?? feedA(), [FEED_B]: over.b ?? feedB(), [WEBHOOK]: over.slack ?? reply.text("ok") });
}

describe("runCommand", () => {
  it("posts the relevant items and records them as notified", async () => {
    const fetch = routes();
    const llm = fakeLlm();
    expect(await exitOf(run(llm))).toBe(ExitCode.OK);

    expect(slackTexts(fetch)).toEqual(["Pochi: 2 updates for my-app (2 High)"]);
    // Each item has an id and a urlKey; the irrelevant one is recorded too.
    expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n"]);
    expect(stdout).toBe("");
    expect(logs).not.toContain("s3cr3t");
  });

  it("posts one update per story and records its other reports as notified", async () => {
    const fetch = routes();
    // The breaking change and the security fix are one story; the fix is the one shown.
    const llm = fakeLlm({
      group: (titles) => ({ groups: [{ ids: ["i1", "i2"], primary: `i${titles.indexOf("Security fix in lib") + 1}` }] }),
    });
    expect(await exitOf(run(llm))).toBe(ExitCode.OK);
    expect(llm.titles("analyze")).toEqual(["Security fix in lib"]);
    expect(slackTexts(fetch)).toEqual(["Pochi: 1 update for my-app (1 High)"]);
    expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n"]);
  });

  it("delivers a story analyzed earlier with its other reports, without asking the LLM again", async () => {
    routes({ slack: reply.status(404) });
    const group = (titles: string[]) => ({
      groups: [{ ids: ["i1", "i2"], primary: `i${titles.indexOf("Security fix in lib") + 1}` }],
    });
    expect(await exitOf(run(fakeLlm({ group })))).toBe(ExitCode.DELIVERY);

    vi.unstubAllGlobals();
    const fetch = routes();
    const llm = fakeLlm({ group });
    expect(await exitOf(run(llm, { json: true }))).toBe(ExitCode.OK);
    expect(llm.calls).toEqual([]);
    expect(slackTexts(fetch)).toEqual(["Pochi: 1 update for my-app (1 High)"]);
    const [insight] = JSON.parse(stdout).insights;
    expect([insight.title, insight.related.map((r: { title: string }) => r.title)]).toEqual([
      "Security fix in lib",
      ["Breaking change in lib"],
    ]);
    expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n"]);
  });

  it("counts the briefings delivered and mentions a round one in the footer", async () => {
    const fetch = routes();
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ version: 1, briefings: 9, entries: {} }));
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.OK);
    expect(JSON.parse(await readFile(statePath, "utf8")).briefings).toBe(10);
    expect(fetch.callsTo(WEBHOOK)[0]!.body).toContain("Fetched by Pochi · 3 items from 2 sources · 10th briefing");

    // Nothing new to deliver: the count stays.
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.OK);
    expect(JSON.parse(await readFile(statePath, "utf8")).briefings).toBe(10);
  });

  it("does not notify or triage known items again, and analyzes pending ones without triage", async () => {
    let fetch = routes();
    // The first run leaves the security fix unanswered by Analyze: state r.
    await run(
      fakeLlm({
        analyze: (ids) => ({ insights: [{ id: ids[0]!, title: "", summary: "", impact: "High", action: "" }] }),
      }),
    );
    expect(slackTexts(fetch)).toEqual(["Pochi: 1 update for my-app (1 High)"]);
    expect(await statuses()).toEqual(["i", "i", "n", "n", "r", "r"]);

    vi.unstubAllGlobals();
    fetch = routes({ a: feedA([{ title: "Breaking change in lib" }, { title: "Boring news" }, { title: "New release" }]) });
    const llm = fakeLlm();
    expect(await exitOf(run(llm))).toBe(ExitCode.OK);
    expect(llm.titles("triage")).toEqual(["New release"]);
    expect(llm.titles("analyze").sort()).toEqual(["New release", "Security fix in lib"]);
    expect(slackTexts(fetch)).toEqual(["Pochi: 2 updates for my-app (2 High)"]);
    expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n", "n", "n"]);
  });

  it("prints a dry run without posting or touching the state file", async () => {
    await mkdir(join(dir, "state"));
    await writeFile(statePath, "not json");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    const fetch = routes();
    expect(await exitOf(run(fakeLlm(), { dryRun: true }))).toBe(ExitCode.OK);

    expect(fetch.callsTo(WEBHOOK)).toHaveLength(0);
    expect(stdout).toContain("Pochi · my-app · 2026-10-26");
    expect(stdout).toContain("[High] Breaking change in lib");
    expect(stdout).toContain("Action: Upgrade");
    expect(await readFile(statePath, "utf8")).toBe("not json");
  });

  it("prints JSON with --json, keeping logs off stdout", async () => {
    routes();
    await run(fakeLlm(), { dryRun: true, json: true, verbose: true });
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ date: "2026-10-26", dryRun: true, collected: 3, attempted: 2, failedSources: [] });
    expect(out.insights.map((f: { title: string }) => f.title)).toEqual(["Breaking change in lib", "Security fix in lib"]);
    expect(out.messages[0].text).toBe("Pochi: 2 updates for my-app (2 High)");
    expect(logs).toContain("debug");
  });

  it("neither reads nor writes the state with --no-state", async () => {
    await mkdir(join(dir, "state"));
    await writeFile(statePath, "not json");
    const fetch = routes();
    await run(fakeLlm(), { state: false });
    expect(slackTexts(fetch)).toHaveLength(1);
    expect(await readFile(statePath, "utf8")).toBe("not json");
  });

  it("exits 4 when Slack rejects the message, without marking anything notified", async () => {
    routes({ slack: reply.status(404) });
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.DELIVERY);
    // Undelivered insights wait as r, so tomorrow analyzes them without triaging them again.
    expect(await statuses()).toEqual(["i", "i", "r", "r", "r", "r"]);
    expect(logs).not.toContain("s3cr3t");
  });

  it("writes a report without a webhook when the file is the only channel", async () => {
    const reports = join(dir, "reports");
    await writeFile(join(dir, "config", "context.yml"), withChannels(`[{ type: file, dir: "${reports}" }]`));
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    const fetch = routes();
    expect(await exitOf(run(fakeLlm(), { json: true }))).toBe(ExitCode.OK);

    expect(fetch.callsTo(WEBHOOK)).toHaveLength(0);
    const report = await readFile(join(reports, "2026-10-26.md"), "utf8");
    expect(report).toContain("[High] [Breaking change in lib]");
    expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n"]);
    expect(JSON.parse(stdout).delivered.file).toHaveLength(2);

    // Delivered items are known now, so the next run has nothing to write.
    vi.unstubAllGlobals();
    routes();
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.OK);
    expect(await readdir(reports)).toEqual(["2026-10-26.md"]);
  });

  it("marks items notified only once every channel has them, and exits 4 naming the one that failed", async () => {
    const reports = join(dir, "reports");
    await writeFile(join(dir, "config", "context.yml"), withChannels(`[{ type: slack }, { type: file, dir: "${reports}" }]`));
    routes({ slack: reply.status(404) });
    let error: unknown;
    await run(fakeLlm()).catch((err: unknown) => (error = err));
    expect(exitCodeOf(error)).toBe(ExitCode.DELIVERY);
    expect((error as Error).message).toBe("delivery failed: slack (2 updates not delivered)");
    // The file got them, Slack did not: they stay r, so Slack gets them tomorrow.
    expect(await readdir(reports)).toEqual(["2026-10-26.md"]);
    expect(await statuses()).toEqual(["i", "i", "r", "r", "r", "r"]);
    const entries = Object.values(await readState()) as { s: string; c?: string[]; a?: { impact: string } }[];
    expect(entries.filter((e) => e.s === "r").every((e) => e.c?.join() === "file" && e.a?.impact === "High")).toBe(true);

    // Tomorrow Slack gets them, the file is not written again, and nothing is analyzed again.
    vi.unstubAllGlobals();
    const fetch = routes();
    const llm = fakeLlm();
    expect(await exitOf(run(llm))).toBe(ExitCode.OK);
    expect(slackTexts(fetch)).toEqual(["Pochi: 2 updates for my-app (2 High)"]);
    expect(await readdir(reports)).toEqual(["2026-10-26.md"]);
    expect(llm.calls).toEqual([]);
    expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n"]);
  });

  it("names the file channel when only it fails, keeping the items for tomorrow", async () => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    await writeFile(join(dir, "config", "context.yml"), withChannels(`[{ type: slack }, { type: file, dir: "${blocker}" }]`));
    const fetch = routes();
    let error: unknown;
    await run(fakeLlm()).catch((err: unknown) => (error = err));
    expect((error as Error).message).toBe("delivery failed: file (2 updates not delivered)");
    expect(slackTexts(fetch)).toHaveLength(1);
    expect(await statuses()).toEqual(["i", "i", "r", "r", "r", "r"]);
  });

  it("exits 130 without writing the file when interrupted after Slack", async () => {
    const reports = join(dir, "reports");
    await writeFile(join(dir, "config", "context.yml"), withChannels(`[{ type: slack }, { type: file, dir: "${reports}" }]`));
    const controller = new AbortController();
    routes({
      slack: () => {
        controller.abort();
        return new Response("ok");
      },
    });
    expect(await exitOf(run(fakeLlm(), {}, { signal: controller.signal }))).toBe(ExitCode.INTERRUPTED);
    expect(await readdir(dir)).not.toContain("reports");
    expect(await statuses()).toEqual(["i", "i", "r", "r", "r", "r"]);

    // What Slack got before the interrupt is recorded: the next run writes the file only.
    vi.unstubAllGlobals();
    const fetch = routes();
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.OK);
    expect(slackTexts(fetch)).toEqual([]);
    expect(await readdir(reports)).toEqual(["2026-10-26.md"]);
    expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n"]);
  });

  it("exits 5 when every source fails, and 0 when only some do", async () => {
    routes({ a: reply.status(500), b: reply.status(404) });
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.SOURCES);

    vi.unstubAllGlobals();
    const fetch = routes({ a: reply.status(404) });
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.OK);
    expect(slackTexts(fetch)).toEqual(["Pochi: 1 update for my-app (1 High)"]);
  });

  it("exits 3 before fetching anything when no LLM is available", async () => {
    const fetch = routes();
    const llm = fakeLlm();
    llm.resolve = async () => {
      throw new LlmError("unavailable", "no LLM available");
    };
    expect(await exitOf(run(llm))).toBe(ExitCode.LLM);
    expect(fetch.calls).toHaveLength(0);
  });

  it("exits 2 without a webhook unless it is a dry run, and when only skipped queries remain", async () => {
    const fetch = routes();
    vi.stubEnv("SLACK_WEBHOOK_URL", " ");
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.CONFIG);

    vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK);
    await writeFile(join(dir, "config", "sources.yml"), `version: 1\nqueries:\n  - { id: q, query: "lib news" }\n`);
    expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.CONFIG);
    expect(fetch.calls).toHaveLength(0);
  });

  it("still posts and saves when the LLM partly failed, then exits 3 (over a Slack failure)", async () => {
    const llm = fakeLlm();
    const generate = llm.client.generate.bind(llm.client);
    llm.client.generate = async (req) => {
      if (req.tier === "analyze") throw new LlmError("auth", "rejected");
      return generate(req);
    };
    routes({ slack: reply.status(404) });
    expect(await exitOf(run(llm))).toBe(ExitCode.LLM);
    // Triage answers are kept: irrelevant as i, relevant but unanalyzed as r.
    expect(await statuses()).toEqual(["i", "i", "r", "r", "r", "r"]);
  });

  it("exits 130 when interrupted, saving what the LLM already decided", async () => {
    const controller = new AbortController();
    const llm = fakeLlm();
    const generate = llm.client.generate.bind(llm.client);
    llm.client.generate = async (req) => {
      const out = await generate(req);
      controller.abort();
      return out;
    };
    const fetch = routes();
    expect(await exitOf(run(llm, {}, { signal: controller.signal }))).toBe(ExitCode.INTERRUPTED);
    expect(fetch.callsTo(WEBHOOK)).toHaveLength(0);
    expect(await statuses()).toEqual(["i", "i", "r", "r", "r", "r"]);
  });

  it("exits 130 when interrupted while collecting", async () => {
    const controller = new AbortController();
    routes({ a: reply.hang(), b: reply.hang() });
    const p = run(fakeLlm(), {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect(await exitOf(p)).toBe(ExitCode.INTERRUPTED);
  });

  it("exits 1 when the state cannot be saved after posting", async () => {
    // Readable, so the run gets as far as posting; read-only, so the temporary file cannot be created.
    await mkdir(join(dir, "state"));
    await writeFile(statePath, `{"version":1,"entries":{}}`);
    await chmod(join(dir, "state"), 0o500);
    try {
      const fetch = routes();
      expect(await exitOf(run(fakeLlm()))).toBe(ExitCode.INTERNAL);
      expect(slackTexts(fetch)).toHaveLength(1);
    } finally {
      await chmod(join(dir, "state"), 0o700);
    }
  });

  describe("since the last run", () => {
    const posts = [1, 2, 3, 4, 6].map((age) => ({ title: `Post ${age}`, age }));
    const savedAt = async () => JSON.parse(await readFile(statePath, "utf8")).updatedAt;

    beforeEach(() => {
      mockFetch({ [FEED_A]: feedA(posts), [FEED_B]: feedB([]), [WEBHOOK]: reply.text("ok") });
    });

    it("looks back as far as the schedule's gap and a day on a first run", async () => {
      // Every day by default: two days.
      const llm = fakeLlm();
      await run(llm);
      expect(llm.titles("triage")).toEqual(["Post 1", "Post 2"]);
      expect(await savedAt()).toBe("2026-10-26T00:00:00Z");

      await rm(statePath);
      await writeFile(join(dir, "config", "context.yml"), `${CONTEXT}schedule: { interval: weekly, day: monday }\n`);
      const weekly = fakeLlm();
      await run(weekly);
      expect(weekly.titles("triage")).toEqual(["Post 1", "Post 2", "Post 3", "Post 4", "Post 6"]);
    });

    it("takes maxItemAgeDays as set over the schedule", async () => {
      await writeFile(join(dir, "config", "context.yml"), `${CONTEXT}state: { maxItemAgeDays: 3 }\n`);
      const llm = fakeLlm();
      await run(llm);
      expect(llm.titles("triage")).toEqual(["Post 1", "Post 2", "Post 3"]);
    });

    it("takes every post from a day before the last run", async () => {
      await mkdir(join(dir, "state"));
      await writeFile(statePath, JSON.stringify({ version: 1, updatedAt: "2026-10-23T00:00:00Z", entries: {} }));
      const llm = fakeLlm();
      await run(llm);
      expect(llm.titles("triage")).toEqual(["Post 1", "Post 2", "Post 3", "Post 4"]);
    });

    it("moves the saved time on while items are left undecided, and triages them next time", async () => {
      await writeFile(
        join(dir, "config", "context.yml"),
        `${CONTEXT}llm: { maxItemsPerRun: 2 }\nstate: { maxItemAgeDays: 7 }\n`,
      );
      await mkdir(join(dir, "state"));
      await writeFile(statePath, JSON.stringify({ version: 1, updatedAt: "2026-10-19T00:00:00Z", entries: {} }));
      const first = fakeLlm();
      await run(first);
      expect(first.titles("triage")).toEqual(["Post 1", "Post 2"]);
      expect(await savedAt()).toBe("2026-10-26T00:00:00Z");
      // The three over maxItemsPerRun wait as u, under both keys.
      expect(await statuses()).toEqual(["n", "n", "n", "n", "u", "u", "u", "u", "u", "u"]);
      // Feed a is held back to its oldest waiting post, so it still returns it.
      expect(JSON.parse(await readFile(statePath, "utf8")).sources).toEqual({
        a: "2026-10-20T00:00:00Z",
        b: "2026-10-26T00:00:00Z",
      });

      const second = fakeLlm();
      await run(second, {}, { now: () => new Date(NOW.getTime() + 86_400_000) });
      expect(second.titles("triage")).toEqual(["Post 3", "Post 4"]);
      expect(await statuses()).toEqual(["n", "n", "n", "n", "n", "n", "n", "n", "u", "u"]);

      // One still untriaged 15 days after it was first seen is given up on, as a pending one is.
      const file = JSON.parse(await readFile(statePath, "utf8"));
      for (const e of Object.values(file.entries) as { s: string; f: string }[]) {
        if (e.s === "u") e.f = "2026-10-11";
      }
      await writeFile(statePath, JSON.stringify(file));
      const third = fakeLlm();
      await run(third, {}, { now: () => new Date(NOW.getTime() + 86_400_000) });
      expect(third.calls).toEqual([]);
      expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n", "n", "n", "n", "n"]);
    });
  });

  it("records new items older than maxItemAgeDays as irrelevant without asking the LLM", async () => {
    routes({ a: feedA([{ title: "Ancient post", age: 30 }, { title: "Breaking change in lib" }]) });
    const llm = fakeLlm();
    await run(llm);
    expect(llm.titles("triage")).toEqual(["Breaking change in lib", "Security fix in lib"]);
    expect(await statuses()).toEqual(["i", "i", "n", "n", "n", "n"]);
  });

  it("gives up on items still awaiting analysis maxItemAgeDays after they were first seen", async () => {
    routes();
    await run(
      fakeLlm({
        analyze: (ids) => ({ insights: [{ id: ids[0]!, title: "", summary: "", impact: "High", action: "" }] }),
      }),
    );
    // The security fix is r; pretend it was first seen 15 days ago (maxItemAgeDays is 14).
    const file = JSON.parse(await readFile(statePath, "utf8"));
    for (const e of Object.values(file.entries) as { s: string; f: string }[]) {
      if (e.s === "r") e.f = "2026-10-11";
    }
    await writeFile(statePath, JSON.stringify(file));

    vi.unstubAllGlobals();
    const fetch = routes();
    const llm = fakeLlm();
    expect(await exitOf(run(llm))).toBe(ExitCode.OK);
    expect(llm.calls).toHaveLength(0);
    expect(slackTexts(fetch)).toEqual([]);
    expect(await statuses()).toEqual(["i", "i", "i", "i", "n", "n"]);
    expect(logs).toContain("gave up on 1 items");
  });

  it("rejects --verbose with --quiet", async () => {
    expect(await exitOf(run(fakeLlm(), { verbose: true, quiet: true }))).toBe(ExitCode.CONFIG);
  });
});
