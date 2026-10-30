import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSchema, SourcesSchema } from "../../src/config/schema.js";
import { ExitCode } from "../../src/errors.js";
import {
  type AnalysisOutput,
  type GenerateRequest,
  GroupingOutputSchema,
  type LlmClient,
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
