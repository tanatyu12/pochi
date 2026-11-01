import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSchema, SourcesSchema } from "../../src/config/schema.js";
import { ExitCode } from "../../src/errors.js";
import {
  type AnalysisOutput,
  type GenerateRequest,
  GroupingOutputSchema,
  type LlmClient,
  LlmError,
  type TriageOutput,
} from "../../src/llm/schema.js";
import type { Briefing, Delivery, Notifier } from "../../src/notifiers/types.js";
import { briefingError, type BriefingInput, itemAgeDays, runBriefing } from "../../src/pipeline/briefing.js";
import { emptyState, memoryStateStore, type StateStore } from "../../src/state/store.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { mockFetch, reply } from "../helpers/mockFetch.js";

const NOW = new Date("2026-10-26T00:00:00Z");
const FEED = "https://a.example.com/feed.xml";

const context = ContextSchema.parse({
  version: 1,
  project: { name: "my-app", description: "A web app" },
  problems: ["keep dependencies current"],
});
const sources = SourcesSchema.parse({
  version: 1,
  feeds: [{ id: "a", type: "rss", name: "Blog A", url: FEED }],
});

function feed(titles: string[]) {
  const items = titles.map(
    (t, i) => `<item><title>${t}</title><link>https://a.example.com/${i}</link>
      <pubDate>${new Date(NOW.getTime() - 86_400_000).toUTCString()}</pubDate></item>`,
  );
  return reply.text(`<?xml version="1.0"?><rss version="2.0"><channel><title>a</title>${items.join("")}</channel></rss>`);
}

/** Triage keeps everything but titles containing "Boring"; analyze rates all High. */
const llm: LlmClient = {
  mode: "api",
  async generate<T>(req: GenerateRequest<T>): Promise<T> {
    const ids = [...req.prompt.matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]!);
    const titles = [...req.prompt.matchAll(/^title: (.*)$/gm)].map((m) => m[1]!);
    if ((req.schema as unknown) === GroupingOutputSchema) return { groups: [] } as T;
    if (req.tier === "triage") {
      const out: TriageOutput = {
        decisions: ids.map((id, i) => ({ id, relevant: !titles[i]!.includes("Boring"), reason: "" })),
      };
      return out as T;
    }
    const out: AnalysisOutput = {
      insights: ids.map((id) => ({ id, title: "", summary: "Read it", impact: "High", action: "Upgrade" })),
    };
    return out as T;
  },
};

/** Delivers everything, or fails every insight when failing is set. */
function fakeNotifier(opts: { failing?: boolean } = {}) {
  const received: Briefing[] = [];
  const notifier: Notifier = {
    name: "fake",
    async deliver(b: Briefing): Promise<Delivery> {
      received.push(b);
      const ids = b.insights.map((f) => f.item.id);
      return opts.failing
        ? { deliveredIds: [], failures: [{ itemIds: ids, error: new Error("down") }], aborted: false }
        : { deliveredIds: ids, failures: [], aborted: false };
    },
  };
  return { notifier, received };
}

/** llm, recording the tier and system prompt of every call. */
function counting() {
  const calls: { tier: string; system: string }[] = [];
  const counted: LlmClient = {
    mode: "api",
    generate: (req, opts) => {
      calls.push({ tier: (req.schema as unknown) === GroupingOutputSchema ? "group" : req.tier, system: req.system });
      return llm.generate(req, opts);
    },
  };
  return { llm: counted, tiers: () => calls.map((c) => c.tier), systems: () => calls.map((c) => c.system) };
}

function input(store: StateStore, notifiers: Notifier[], extra: Partial<BriefingInput> = {}): BriefingInput {
  return { context, sources, llm, notifiers, store, dryRun: false, ...extra };
}

const deps = { now: () => NOW, retryDelayMs: 0 };

beforeEach(() => {
  configureLog({ write: () => {} });
  mockFetch({ [FEED]: feed(["Breaking change in lib", "Boring news"]) });
});

afterEach(() => {
  resetLog();
  vi.unstubAllGlobals();
});

describe("runBriefing", () => {
  it("delivers the relevant items, records them in the store, and does not deliver them again", async () => {
    const store = memoryStateStore();
    const { notifier, received } = fakeNotifier();
    const first = await runBriefing(input(store, [notifier]), deps);
    expect(first.briefing.insights.map((f) => f.item.title)).toEqual(["Breaking change in lib"]);
    expect(first.delivered.size).toBe(1);
    expect(briefingError(first)).toBeUndefined();

    const second = await runBriefing(input(store, [notifier]), deps);
    expect(second.briefing.insights).toEqual([]);
    expect(received).toHaveLength(2);
    expect((await store.load({ now: NOW })).briefings).toBe(1);
  });

  it("neither delivers nor saves on a dry run", async () => {
    const store = memoryStateStore();
    const save = vi.spyOn(store, "save");
    const { notifier, received } = fakeNotifier();
    const result = await runBriefing(input(store, [notifier], { dryRun: true }), deps);
    expect(result.briefing.insights).toHaveLength(1);
    expect(result.sent).toEqual([]);
    expect(received).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });

  it("returns a failed delivery for briefingError and keeps the item for the next run", async () => {
    const store = memoryStateStore();
    const result = await runBriefing(input(store, [fakeNotifier({ failing: true }).notifier]), deps);
    expect(result.delivered.size).toBe(0);
    expect(briefingError(result)).toMatchObject({ exitCode: ExitCode.DELIVERY, message: "delivery failed: fake (1 updates not delivered)" });

    const { notifier, received } = fakeNotifier();
    await runBriefing(input(store, [notifier]), deps);
    expect(received[0]?.insights.map((f) => f.item.title)).toEqual(["Breaking change in lib"]);
  });

  it("does not analyze an insight again while its delivery keeps failing", async () => {
    const store = memoryStateStore();
    const counted = counting();
    await runBriefing(input(store, [fakeNotifier({ failing: true }).notifier], { llm: counted.llm }), deps);
    expect(counted.tiers()).toEqual(["triage", "analyze"]);

    const again = counting();
    const { notifier, received } = fakeNotifier();
    const result = await runBriefing(input(store, [notifier], { llm: again.llm }), deps);
    expect(again.tiers()).toEqual([]);
    expect(received[0]?.insights.map((f) => [f.title, f.summary, f.impact, f.action])).toEqual([
      ["Breaking change in lib", "Read it", "High", "Upgrade"],
    ]);
    expect(result.delivered.size).toBe(1);
  });

  it("sends a channel only what it does not have yet", async () => {
    const store = memoryStateStore();
    const good = fakeNotifier();
    const bad = { ...fakeNotifier({ failing: true }).notifier, name: "other" };
    const first = await runBriefing(input(store, [good.notifier, bad]), deps);
    expect(first.delivered.size).toBe(0);

    const fixed = fakeNotifier();
    const second = await runBriefing(input(store, [good.notifier, { ...fixed.notifier, name: "other" }]), deps);
    expect(good.received.map((b) => b.insights.length)).toEqual([1, 0]);
    expect(fixed.received.map((b) => b.insights.length)).toEqual([1]);
    expect(second.delivered.size).toBe(1);
  });

  it("dates the briefing and tells the model the day on the schedule's clock", async () => {
    const counted = counting();
    const tokyo = { ...context, schedule: { ...context.schedule, timezone: "Asia/Tokyo" } };
    // 08:30 on the 26th in Tokyo is still the 25th in UTC.
    const at = { ...deps, now: () => new Date("2026-10-25T23:30:00Z") };
    const result = await runBriefing(input(memoryStateStore(), [], { context: tokyo, llm: counted.llm, dryRun: true }), at);
    expect(result.briefing.date).toBe("2026-10-26");
    expect(counted.systems()[0]).toContain("Today is 2026-10-26");

    const local = await runBriefing(input(memoryStateStore(), [], { dryRun: true }), { ...at, timeZone: "America/New_York" });
    expect(local.briefing.date).toBe("2026-10-25");
  });

  it("starts a source that failed where it started the last time", async () => {
    const SEARCH = "https://api.tavily.com/search";
    const withQuery = SourcesSchema.parse({
      version: 1,
      feeds: [{ id: "a", type: "rss", name: "Blog A", url: FEED }],
      queries: [{ id: "q", query: "lib news" }],
    });
    const store = memoryStateStore();
    await store.save(emptyState(), { now: new Date("2026-10-25T00:00:00Z") });
    const run = (now: Date) =>
      runBriefing(input(store, [fakeNotifier().notifier], { sources: withQuery }), {
        ...deps,
        now: () => now,
        timeZone: "UTC",
        env: { TAVILY_API_KEY: "tvly-test" },
      });

    mockFetch({ [FEED]: feed(["Breaking change in lib"]), [SEARCH]: reply.status(400) });
    const first = await run(NOW);
    expect(first.briefing.failedSources).toEqual(["lib news"]);
    expect([...((await store.load({ now: NOW })).sources ?? [])].map(([id, t]) => [id, t.toISOString()])).toEqual([
      ["a", "2026-10-26T00:00:00.000Z"],
      ["q", "2026-10-25T00:00:00.000Z"],
    ]);

    vi.unstubAllGlobals();
    const mock = mockFetch({ [FEED]: feed([]), [SEARCH]: reply.json({ results: [] }) });
    await run(new Date("2026-10-27T00:00:00Z"));
    // Its last since (a day before the run before), not a day before the run that it failed in.
    expect(mock.callsTo(SEARCH).map((c) => JSON.parse(c.body!).start_date)).toEqual(["2026-10-24"]);
  });

  it("forgets the time of a source no longer configured", async () => {
    const store = memoryStateStore();
    await store.save({ ...emptyState(), sources: new Map([["gone", NOW]]) }, { now: NOW });
    await runBriefing(input(store, [fakeNotifier().notifier]), deps);
    expect([...((await store.load({ now: NOW })).sources?.keys() ?? [])]).toEqual(["a"]);
  });

  it("throws an interrupt as a PochiError when aborted while collecting", async () => {
    mockFetch({ [FEED]: reply.hang() });
    const controller = new AbortController();
    const p = runBriefing(input(memoryStateStore(), []), { ...deps, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toMatchObject({ exitCode: ExitCode.INTERRUPTED, message: "interrupted" });
  });

  it("checks the LLM before it loads the state or fetches anything", async () => {
    const fetches = mockFetch({ [FEED]: feed(["Breaking change in lib"]) });
    const store = memoryStateStore();
    const load = vi.spyOn(store, "load");
    const unusable: LlmClient = {
      ...llm,
      preflight: async () => {
        throw new LlmError("auth", "Anthropic API rejected ANTHROPIC_API_KEY");
      },
    };
    await expect(runBriefing(input(store, [], { llm: unusable }), deps)).rejects.toMatchObject({
      kind: "auth",
      exitCode: ExitCode.LLM,
    });
    expect(fetches.calls).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("saves what was decided before an unexpected error, then throws that error", async () => {
    const store = memoryStateStore();
    const bug = new TypeError("bug");
    const broken: LlmClient = {
      mode: "api",
      generate: (req, opts) => (req.tier === "analyze" ? Promise.reject(bug) : llm.generate(req, opts)),
    };
    await expect(runBriefing(input(store, [fakeNotifier().notifier], { llm: broken }), deps)).rejects.toBe(bug);

    // The triage answers were kept: the next run only analyzes the relevant item.
    const next = counting();
    const { notifier, received } = fakeNotifier();
    await runBriefing(input(store, [notifier], { llm: next.llm }), deps);
    expect(next.tiers()).toEqual(["analyze"]);
    expect(received[0]?.insights.map((f) => f.item.title)).toEqual(["Breaking change in lib"]);
  });

  it("saves nothing after an unexpected error on a dry run", async () => {
    const store = memoryStateStore();
    const save = vi.spyOn(store, "save");
    const bug = new TypeError("bug");
    const broken: LlmClient = { mode: "api", generate: () => Promise.reject(bug) };
    await expect(runBriefing(input(store, [], { llm: broken, dryRun: true }), deps)).rejects.toBe(bug);
    expect(save).not.toHaveBeenCalled();
  });

  it("throws when every source fails", async () => {
    mockFetch({ [FEED]: reply.status(404) });
    await expect(runBriefing(input(memoryStateStore(), []), deps)).rejects.toMatchObject({ exitCode: ExitCode.SOURCES });
  });
});

describe("itemAgeDays", () => {
  const NOW = new Date("2026-10-30T00:30:00Z"); // Fri 09:30 in Tokyo
  const contextWith = (extra: object) =>
    ContextSchema.parse({ version: 1, project: { name: "app", description: "" }, problems: ["p"], ...extra });
  const zoned = (schedule: object) => contextWith({ schedule: { timezone: "Asia/Tokyo", ...schedule } });

  it.each([
    ["every day", { interval: "daily" }, 2],
    ["Friday and Saturday", { interval: "weekly", day: ["friday", "saturday"] }, 7],
    ["once a week", { interval: "weekly", day: "monday" }, 8],
    ["once a month", { interval: "monthly" }, 32],
  ])("looks back the longest gap and a day when run %s", (_, schedule, days) => {
    expect(itemAgeDays(zoned(schedule), emptyState(), NOW)).toBe(days);
  });

  it("looks back to the last run when runs were missed", () => {
    const state = { ...emptyState(), updatedAt: new Date("2026-10-20T00:20:00Z") };
    expect(itemAgeDays(zoned({ interval: "daily" }), state, NOW)).toBe(12);
  });

  it("takes maxItemAgeDays as set, and stays short of ttlDays", () => {
    expect(itemAgeDays(contextWith({ state: { maxItemAgeDays: 3 } }), emptyState(), NOW)).toBe(3);
    const longAgo = { ...emptyState(), updatedAt: new Date("2026-01-01T00:00:00Z") };
    expect(itemAgeDays(zoned({ interval: "daily" }), longAgo, NOW)).toBe(44);
  });
});
