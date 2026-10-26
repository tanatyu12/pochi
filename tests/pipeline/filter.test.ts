import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Context, ContextSchema, type Impact } from "../../src/config/schema.js";
import { ExitCode, exitCodeOf } from "../../src/errors.js";
import {
  type AnalysisOutput,
  type GenerateRequest,
  type LlmClient,
  LlmError,
  type LlmErrorKind,
  type TriageOutput,
} from "../../src/llm/schema.js";
import { ANALYZE_BATCH_SIZE, filterAndAnalyze, RETRY_DELAY_MS } from "../../src/pipeline/filter.js";
import type { Item } from "../../src/types.js";
import { configureLog, resetLog } from "../../src/util/log.js";

function makeContext(over: { llm?: Record<string, unknown>; minImpact?: Impact } = {}): Context {
  return ContextSchema.parse({
    version: 1,
    project: { name: "my-app", description: "" },
    problems: ["anything"],
    llm: over.llm ?? {},
    notify: { slack: { minImpact: over.minImpact ?? "Low" } },
  });
}

function item(n: number, over: Partial<Item> = {}): Item {
  return {
    id: `id${n}`,
    sourceId: "blog",
    sourceName: "Blog",
    kind: "rss",
    title: `Title ${n}`,
    url: `https://example.com/${n}`,
    urlKey: `key${n}`,
    content: `Content ${n}`,
    ...over,
  };
}

const items = (count: number, from = 1) => Array.from({ length: count }, (_, i) => item(from + i));

interface Call {
  tier: string;
  /** The short ids in the prompt, and the item titles they stand for. */
  ids: string[];
  titles: string[];
}

function parseCall(req: GenerateRequest<unknown>): Call {
  return {
    tier: req.tier,
    ids: [...req.prompt.matchAll(/<item id="(i\d+)">/g)].map((m) => m[1]!),
    titles: [...req.prompt.matchAll(/^title: (.*)$/gm)].map((m) => m[1]!),
  };
}

type Handler = (call: Call, n: number) => unknown;

/**
 * A client that answers each call with the handler for its tier. By default triage marks every
 * item relevant and analyze rates each one Medium, both keyed by the title so tests can pick.
 */
function fakeLlm(handlers: { triage?: Handler; analyze?: Handler } = {}) {
  const calls: Call[] = [];
  const counts = { triage: 0, analyze: 0 };
  const client: LlmClient = {
    mode: "api",
    async generate<T>(req: GenerateRequest<T>): Promise<T> {
      const call = parseCall(req);
      calls.push(call);
      const tier = req.tier;
      const n = counts[tier]++;
      const handler = handlers[tier] ?? (tier === "triage" ? relevantAll : insightAll());
      return handler(call, n) as T;
    },
  };
  return { client, calls, of: (tier: string) => calls.filter((c) => c.tier === tier) };
}

const relevantAll: Handler = (call): TriageOutput => ({
  decisions: call.ids.map((id) => ({ id, relevant: true, reason: "r" })),
});

function insightAll(impactOf: (title: string) => Impact = () => "Medium"): Handler {
  return (call): AnalysisOutput => ({
    insights: call.ids.map((id, i) => ({
      id,
      title: `Insight for ${call.titles[i]}`,
      summary: "s",
      impact: impactOf(call.titles[i]!),
      action: "a",
    })),
  });
}

function fail(kind: LlmErrorKind = "transport"): never {
  throw new LlmError(kind, `failed: ${kind}`);
}

const titles = (list: readonly Item[]) => list.map((i) => i.title);

let logs: string[];

beforeEach(() => {
  logs = [];
  configureLog({ level: "verbose", write: (s) => logs.push(s) });
});

afterEach(() => {
  vi.useRealTimers();
  resetLog();
});

describe("filterAndAnalyze batching", () => {
  it("does not call the model for no items", async () => {
    const llm = fakeLlm();
    const result = await filterAndAnalyze(llm.client, makeContext(), []);
    expect(llm.calls).toHaveLength(0);
    expect(result).toMatchObject({ insights: [], irrelevant: [], undecided: [] });
  });

  it("triages in batches of maxItemsPerCall and analyzes the relevant ones in batches of 15", async () => {
    expect(ANALYZE_BATCH_SIZE).toBe(15);
    const llm = fakeLlm({
      // 30 of the 95 are relevant: the first 10 of each triage batch.
      triage: (call) => ({ decisions: call.ids.map((id, i) => ({ id, relevant: i < 10, reason: "r" })) }),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(95));
    expect(llm.of("triage").map((c) => c.ids.length)).toEqual([40, 40, 15]);
    expect(llm.of("analyze").map((c) => c.ids.length)).toEqual([15, 15]);
    expect(llm.calls.map((c) => c.tier)).toEqual(["triage", "triage", "triage", "analyze", "analyze"]);
    expect(result.insights).toHaveLength(30);
    expect(result.irrelevant).toHaveLength(65);
    expect(result.undecided).toHaveLength(0);
    expect(result.stats).toEqual({ triageBatches: 3, triageFailed: 0, analyzeBatches: 2, analyzeFailed: 0, dropped: 0 });
  });

  it("honors a configured maxItemsPerCall", async () => {
    const llm = fakeLlm();
    await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 4 } }), items(10));
    expect(llm.of("triage").map((c) => c.ids.length)).toEqual([4, 4, 2]);
  });

  it("keeps the newest maxItemsPerRun items and leaves the rest undecided", async () => {
    const list = [
      item(1, { publishedAt: "2026-10-20T00:00:00Z" }),
      item(2),
      item(3, { publishedAt: "2026-10-25T00:00:00Z" }),
      item(4, { publishedAt: "2026-10-22T00:00:00Z" }),
    ];
    const llm = fakeLlm();
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerRun: 2 } }), list);
    expect(llm.of("triage")[0]?.titles).toEqual(["Title 3", "Title 4"]);
    expect(titles(result.undecided)).toEqual(["Title 1", "Title 2"]);
  });
});

describe("filterAndAnalyze short ids", () => {
  it("maps each batch's ids back to that batch's items", async () => {
    const llm = fakeLlm({
      // Only i1 of each batch is relevant.
      triage: (call) => ({ decisions: call.ids.map((id) => ({ id, relevant: id === "i1", reason: "r" })) }),
    });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 3 } }), items(6));
    expect(titles(result.insights.map((i) => i.item)).sort()).toEqual(["Title 1", "Title 4"]);
    expect(result.insights.map((i) => i.title).sort()).toEqual(["Insight for Title 1", "Insight for Title 4"]);
  });

  it("drops unknown ids, ignores repeats and leaves unanswered items undecided", async () => {
    const llm = fakeLlm({
      triage: () => ({
        decisions: [
          { id: "i1", relevant: false, reason: "first wins" },
          { id: "i1", relevant: true, reason: "repeat" },
          { id: "i9", relevant: true, reason: "unknown" },
          { id: "id2", relevant: true, reason: "not a short id" },
          { id: " i3 ", relevant: true, reason: "padded" },
        ],
      }),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(3));
    expect(titles(result.irrelevant)).toEqual(["Title 1"]);
    expect(titles(result.undecided)).toEqual(["Title 2"]);
    expect(titles(result.insights.map((i) => i.item))).toEqual(["Title 3"]);
    expect(llm.of("analyze")[0]?.titles).toEqual(["Title 3"]);
  });

  it("leaves relevant items without an insight pending", async () => {
    const llm = fakeLlm({
      analyze: (call) => ({
        insights: [{ id: call.ids[1], title: "t", summary: "s", impact: "High", action: "a" }],
      }),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(3));
    expect(titles(result.insights.map((i) => i.item))).toEqual(["Title 2"]);
    expect(titles(result.pending)).toEqual(["Title 1", "Title 3"]);
    expect(result.undecided).toEqual([]);
  });

  it("falls back to the item title when the insight title is blank, and trims the prose", async () => {
    const llm = fakeLlm({
      analyze: (call) => ({
        insights: [{ id: call.ids[0], title: "  ", summary: " s ", impact: "Low", action: "\n" }],
      }),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(1));
    expect(result.insights[0]).toMatchObject({ title: "Title 1", summary: "s", action: "" });
  });
});

describe("filterAndAnalyze failures", () => {
  // Transient failures are retried after RETRY_DELAY_MS; the tests do not wait for it.
  const NOW = { retryDelayMs: 0 };

  it.each(["rate_limit", "timeout", "transport"] as const)("retries a batch that failed with %s once", async (kind) => {
    const llm = fakeLlm({ triage: (call, n) => (n === 0 ? fail(kind) : relevantAll(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(2), NOW);
    expect(llm.of("triage")).toHaveLength(2);
    expect(llm.of("triage")[1]?.titles).toEqual(["Title 1", "Title 2"]);
    expect(result.insights).toHaveLength(2);
    expect(result.stats.triageFailed).toBe(0);
  });

  it("waits RETRY_DELAY_MS before retrying", async () => {
    vi.useFakeTimers();
    const llm = fakeLlm({ triage: (call, n) => (n === 0 ? fail("rate_limit") : relevantAll(call, n)) });
    const promise = filterAndAnalyze(llm.client, makeContext(), items(2));
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    expect(llm.of("triage")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await promise).insights).toHaveLength(2);
    expect(llm.of("triage")).toHaveLength(2);
  });

  it("returns aborted, without throwing, when aborted while waiting to retry", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const llm = fakeLlm({ triage: () => fail("rate_limit") });
    const promise = filterAndAnalyze(llm.client, makeContext(), items(2), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new Error("stop"));
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.undecided).toHaveLength(2);
    expect(result.error).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
  });

  it("leaves a batch that fails twice undecided and carries on", async () => {
    // Batch 2 (calls 1 and 2) fails both times; batches 1 and 3 succeed.
    const llm = fakeLlm({ triage: (call, n) => (n === 1 || n === 2 ? fail() : relevantAll(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(6), NOW);
    expect(llm.of("triage")).toHaveLength(4);
    expect(titles(result.undecided)).toEqual(["Title 3", "Title 4"]);
    expect(result.insights).toHaveLength(4);
    expect(result.stats).toMatchObject({ triageBatches: 3, triageFailed: 1 });
    expect(result.error).toBeUndefined();
    expect(logs.join("")).toContain("triage batch 2/3 failed");
  });

  it.each(["max_tokens", "refusal", "invalid_output", "too_large"] as const)(
    "sends a batch that failed with %s in halves instead of as is",
    async (kind) => {
      const llm = fakeLlm({ analyze: (call, n) => (n === 0 ? fail(kind) : insightAll()(call, n)) });
      const result = await filterAndAnalyze(llm.client, makeContext(), items(5), NOW);
      expect(llm.of("analyze").map((c) => c.titles)).toEqual([
        ["Title 1", "Title 2", "Title 3", "Title 4", "Title 5"],
        ["Title 1", "Title 2", "Title 3"],
        ["Title 4", "Title 5"],
      ]);
      expect(result.insights).toHaveLength(5);
      expect(result.stats.analyzeFailed).toBe(0);
    },
  );

  it("narrows a failure down to the one item causing it and records only that item as irrelevant", async () => {
    const llm = fakeLlm({
      analyze: (call, n) => (call.titles.includes("Title 3") ? fail("refusal") : insightAll()(call, n)),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(4), NOW);
    expect(llm.of("analyze").map((c) => c.titles)).toEqual([
      ["Title 1", "Title 2", "Title 3", "Title 4"],
      ["Title 1", "Title 2"],
      ["Title 3", "Title 4"],
      ["Title 3"],
      ["Title 4"],
      ["Title 3"], // sent again to confirm
    ]);
    expect(titles(result.irrelevant)).toEqual(["Title 3"]);
    expect(result.pending).toEqual([]);
    expect(result.insights).toHaveLength(3);
    expect(result.stats).toMatchObject({ analyzeBatches: 1, analyzeFailed: 0, dropped: 1 });
    expect(result.error).toBeUndefined();
    expect(logs.join("")).toContain("blog/id3 alone makes the request fail");
  });

  it("finds the one item in a batch of 40 in about 2·log2(n) calls", async () => {
    const llm = fakeLlm({
      triage: (call, n) => (call.titles.includes("Title 29") ? fail("max_tokens") : relevantAll(call, n)),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(40), NOW);
    expect(llm.of("triage").length).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(40)));
    expect(titles(result.irrelevant)).toEqual(["Title 29"]);
    expect(result.undecided).toEqual([]);
    expect(result.stats).toMatchObject({ triageFailed: 0, dropped: 1 });
  });

  it("stops splitting when both halves fail, since no one item is the cause", async () => {
    const llm = fakeLlm({ triage: () => fail("refusal") });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(40), NOW);
    expect(llm.of("triage")).toHaveLength(3);
    expect(result.undecided).toHaveLength(40);
    expect(result.irrelevant).toEqual([]);
    expect(result.stats).toMatchObject({ triageFailed: 1, dropped: 0 });
    expect(result.error?.kind).toBe("refusal");
  });

  it.each(["too_large", "max_tokens"] as const)("keeps splitting both halves after %s, since smaller parts fit", async (kind) => {
    const llm = fakeLlm({ triage: (call, n) => (call.ids.length > 2 ? fail(kind) : relevantAll(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(8), NOW);
    // 8, then 4 + 4 (both too large), then 2 + 2 for each.
    expect(llm.of("triage").map((c) => c.ids.length)).toEqual([8, 4, 4, 2, 2, 2, 2]);
    expect(result.undecided).toEqual([]);
    expect(result.insights).toHaveLength(8);
    expect(result.stats.triageFailed).toBe(0);
  });

  it("bounds the calls splitting one batch may make", async () => {
    const llm = fakeLlm({ triage: () => fail("max_tokens") });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(40), NOW);
    // The first call, then at most 2 + 4·log2(40) more.
    expect(llm.of("triage")).toHaveLength(1 + 2 + 4 * 6);
    expect(result.undecided).toHaveLength(40);
    expect(result.irrelevant).toEqual([]);
  });

  it("does not drop an item before anything in the run has been answered", async () => {
    const llm = fakeLlm({
      triage: (call) => (call.titles.includes("Title 1") ? fail("refusal") : fail("transport")),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(2), NOW);
    expect(result.irrelevant).toEqual([]);
    expect(titles(result.undecided).sort()).toEqual(["Title 1", "Title 2"]);
    expect(result.stats.dropped).toBe(0);
  });

  it("drops a batch of one that keeps failing once the run has answers", async () => {
    // Batch 1 (Title 1) answers; batch 2 holds only Title 2, which is always refused.
    const llm = fakeLlm({ triage: (call, n) => (call.titles.includes("Title 2") ? fail("refusal") : relevantAll(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 1 } }), items(2), NOW);
    expect(llm.of("triage").map((c) => c.titles)).toEqual([["Title 1"], ["Title 2"], ["Title 2"]]);
    expect(titles(result.irrelevant)).toEqual(["Title 2"]);
    expect(result.stats).toMatchObject({ triageFailed: 0, dropped: 1 });
    expect(result.error).toBeUndefined();
  });

  it("leaves analyze items pending when both halves fail", async () => {
    const llm = fakeLlm({ analyze: () => fail("invalid_output") });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(4), NOW);
    expect(llm.of("analyze")).toHaveLength(3);
    expect(result.pending).toHaveLength(4);
    expect(result.undecided).toEqual([]);
  });

  it("treats a reply that answers none of the batch's ids as invalid output and splits the batch", async () => {
    const llm = fakeLlm({
      triage: (call, n) =>
        n === 0 ? { decisions: [{ id: "item1", relevant: true, reason: "r" }] } : relevantAll(call, n),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(4), NOW);
    expect(llm.of("triage").map((c) => c.ids.length)).toEqual([4, 2, 2]);
    expect(result.insights).toHaveLength(4);
    expect(result.stats.triageFailed).toBe(0);
  });

  it("returns an error when no batch ever gets a matching id", async () => {
    const llm = fakeLlm({ triage: () => ({ decisions: [{ id: "item1", relevant: true, reason: "r" }] }) });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(4), NOW);
    expect(result.error?.kind).toBe("invalid_output");
    expect(result.undecided).toHaveLength(4);
  });

  it("does not split, retry or drop a batch of one that fails because of its content", async () => {
    const llm = fakeLlm({ triage: () => fail("max_tokens") });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(1), NOW);
    expect(llm.of("triage")).toHaveLength(1);
    expect(titles(result.undecided)).toEqual(["Title 1"]);
    expect(result.irrelevant).toEqual([]);
    expect(result.error?.kind).toBe("max_tokens");
  });

  it.each(["auth", "unavailable"] as const)("stops calling after %s, without retrying", async (kind) => {
    const llm = fakeLlm({ triage: (call, n) => (n === 1 ? fail(kind) : relevantAll(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(6), NOW);
    // Batch 1 succeeded, but analyze has no call left to make, so the stage reports the error.
    expect(result.error?.kind).toBe(kind);
    expect(llm.of("triage")).toHaveLength(2);
    expect(llm.of("analyze")).toHaveLength(0);
    expect(titles(result.undecided)).toEqual(["Title 3", "Title 4", "Title 5", "Title 6"]);
    expect(titles(result.pending)).toEqual(["Title 1", "Title 2"]);
  });

  it("stops calling when rate_limit outlasts the retry", async () => {
    const llm = fakeLlm({ triage: () => fail("rate_limit") });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(6), NOW);
    expect(llm.of("triage")).toHaveLength(2);
    expect(result.undecided).toHaveLength(6);
    expect(result.error?.kind).toBe("rate_limit");
  });

  it("returns the error that stopped the run even when no stage failed outright", async () => {
    const llm = fakeLlm({
      triage: (call, n) =>
        n === 1 ? fail("auth") : { decisions: call.ids.map((id) => ({ id, relevant: false, reason: "r" })) },
    });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(4), NOW);
    // Batch 1 answered and nothing is relevant, so analyze has no batch to fail.
    expect(result.stats).toMatchObject({ triageFailed: 1, analyzeBatches: 0 });
    expect(result.error?.kind).toBe("auth");
    expect(result.error?.message).toContain("stopped after");
    expect(exitCodeOf(result.error!)).toBe(ExitCode.LLM);
  });

  it("keeps the triage answers when a later fatal error leaves analyze with nothing", async () => {
    const llm = fakeLlm({
      triage: (call, n) =>
        n === 1 ? fail("auth") : { decisions: call.ids.map((id, i) => ({ id, relevant: i === 0, reason: "r" })) },
    });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(4), NOW);
    expect(titles(result.irrelevant)).toEqual(["Title 2"]);
    expect(result.error).toBeInstanceOf(LlmError);
    // Analyze was never sent, so it did not fail: the run stopped.
    expect(result.error?.message).toContain("stopped after");
    expect(result.stats).toMatchObject({ analyzeBatches: 1, analyzeFailed: 0 });
  });

  it("returns exit 3 when every triage batch fails, without calling analyze", async () => {
    const llm = fakeLlm({ triage: () => fail("timeout") });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(3), NOW);
    const err = result.error!;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("timeout");
    expect(exitCodeOf(err)).toBe(ExitCode.LLM);
    expect(err.message).toContain("all 2 batches failed");
    expect(llm.of("triage")).toHaveLength(4);
    expect(llm.of("analyze")).toHaveLength(0);
    expect(result.undecided).toHaveLength(3);
  });

  it("returns exit 3 when every analyze batch fails, with the triage answers", async () => {
    const llm = fakeLlm({
      triage: (call) => ({ decisions: call.ids.map((id, i) => ({ id, relevant: i < 3, reason: "r" })) }),
      analyze: () => fail("transport"),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(4), NOW);
    expect(result.error?.kind).toBe("transport");
    expect(result.error?.message).toContain("analyze: the only batch failed");
    expect(titles(result.irrelevant)).toEqual(["Title 4"]);
    expect(result.pending).toHaveLength(3);
    expect(result.undecided).toEqual([]);
  });

  it("does not report an error when analyze only partly fails", async () => {
    const llm = fakeLlm({ analyze: (call, n) => (n < 2 ? fail() : insightAll()(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(20), NOW);
    expect(result.stats).toMatchObject({ analyzeBatches: 2, analyzeFailed: 1 });
    expect(result.pending).toHaveLength(15);
    expect(result.insights).toHaveLength(5);
    expect(result.error).toBeUndefined();
  });

  it("does not call analyze when nothing is relevant", async () => {
    const llm = fakeLlm({ triage: (call) => ({ decisions: call.ids.map((id) => ({ id, relevant: false, reason: "r" })) }) });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(3));
    expect(llm.of("analyze")).toHaveLength(0);
    expect(result.irrelevant).toHaveLength(3);
    expect(result.stats.analyzeBatches).toBe(0);
  });

  it("returns aborted without retrying, keeping what was decided before", async () => {
    const controller = new AbortController();
    const llm = fakeLlm({
      triage: (call, n) => {
        if (n === 0) return { decisions: call.ids.map((id) => ({ id, relevant: false, reason: "r" })) };
        controller.abort(new Error("stop"));
        return fail("transport");
      },
    });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(6), {
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(titles(result.irrelevant)).toEqual(["Title 1", "Title 2"]);
    expect(titles(result.undecided)).toEqual(["Title 3", "Title 4", "Title 5", "Title 6"]);
    expect(result.error).toBeUndefined();
    expect(llm.calls).toHaveLength(2);
  });

  it("leaves the analyze items an abort cut off pending", async () => {
    const controller = new AbortController();
    const llm = fakeLlm({
      analyze: (call, n) => {
        if (n === 0) return insightAll()(call, n);
        controller.abort(new Error("stop"));
        return fail("transport");
      },
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(40), { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.insights).toHaveLength(15);
    expect(result.pending).toHaveLength(25);
    expect(llm.of("analyze")).toHaveLength(2);
  });

  it("does not drop an item that answers when it is sent again", async () => {
    let tries = 0;
    const llm = fakeLlm({
      analyze: (call, n) => {
        if (call.titles.length > 1 && call.titles.includes("Title 2")) return fail("max_tokens");
        if (call.titles.length === 1 && call.titles[0] === "Title 2" && tries++ === 0) return fail("max_tokens");
        return insightAll()(call, n);
      },
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(2), NOW);
    expect(result.irrelevant).toEqual([]);
    expect(result.insights).toHaveLength(2);
    expect(result.stats.dropped).toBe(0);
  });

  it("stops the run when every request is rejected as bad_request", async () => {
    const llm = fakeLlm({ triage: () => fail("bad_request") });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 4 } }), items(12), NOW);
    // Batches 1 and 2 with their two halves each; two batches in a row with no answer stop the run.
    expect(llm.of("triage")).toHaveLength(6);
    expect(result.error?.kind).toBe("bad_request");
    expect(result.undecided).toHaveLength(12);
  });

  it("records the one item a bad_request is about as irrelevant and carries on", async () => {
    const llm = fakeLlm({
      triage: (call, n) => (call.titles.includes("Title 2") ? fail("bad_request") : relevantAll(call, n)),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(4), NOW);
    expect(titles(result.irrelevant)).toEqual(["Title 2"]);
    expect(result.insights).toHaveLength(3);
    expect(result.error).toBeUndefined();
  });

  it("stops after transient failures in two batches in a row", async () => {
    const llm = fakeLlm({ triage: () => fail("transport") });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(8), NOW);
    // Two batches, each sent twice; batches 3 and 4 are skipped.
    expect(llm.of("triage")).toHaveLength(4);
    expect(result.error?.kind).toBe("transport");
    expect(result.undecided).toHaveLength(8);
  });

  it("counts transient failures again after an answer", async () => {
    // Batches 1 and 3 fail (calls 0-1 and 3-4), batch 2 answers in between, batch 4 answers.
    const llm = fakeLlm({ triage: (call, n) => ([0, 1, 3, 4].includes(n) ? fail("timeout") : relevantAll(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(8), NOW);
    expect(llm.of("triage")).toHaveLength(6);
    expect(result.stats.triageFailed).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it("stops a run of single-item batches that are all rejected", async () => {
    const llm = fakeLlm({ triage: () => fail("bad_request") });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 1 } }), items(5), NOW);
    expect(llm.of("triage")).toHaveLength(2);
    expect(result.error?.kind).toBe("bad_request");
    expect(result.undecided).toHaveLength(5);
  });

  it("does not send the next batch once the signal has aborted", async () => {
    const controller = new AbortController();
    const llm = fakeLlm({
      triage: (call, n) => {
        controller.abort(new Error("stop"));
        return relevantAll(call, n);
      },
    });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(4), {
      signal: controller.signal,
    });
    expect(llm.calls).toHaveLength(1);
    expect(result.aborted).toBe(true);
    expect(titles(result.undecided)).toEqual(["Title 3", "Title 4"]);
    expect(titles(result.pending)).toEqual(["Title 1", "Title 2"]);
  });

  it("does not catch errors that are not LlmErrors", async () => {
    const bug = new TypeError("bug");
    const llm = fakeLlm({
      triage: () => {
        throw bug;
      },
    });
    await expect(filterAndAnalyze(llm.client, makeContext(), items(2))).rejects.toBe(bug);
    expect(llm.calls).toHaveLength(1);
  });
});

describe("filterAndAnalyze pretriaged items", () => {
  it("analyzes pretriaged items without triaging them", async () => {
    const llm = fakeLlm();
    const result = await filterAndAnalyze(llm.client, makeContext(), items(2), { pretriaged: items(2, 10) });
    expect(llm.of("triage").map((c) => c.titles)).toEqual([["Title 1", "Title 2"]]);
    expect(llm.of("analyze").map((c) => c.titles)).toEqual([["Title 10", "Title 11", "Title 1", "Title 2"]]);
    expect(result.insights).toHaveLength(4);
  });

  it("analyzes pretriaged items when there is nothing new", async () => {
    const llm = fakeLlm();
    const result = await filterAndAnalyze(llm.client, makeContext(), [], { pretriaged: items(1) });
    expect(llm.of("triage")).toHaveLength(0);
    expect(result.insights).toHaveLength(1);
  });

  it("counts pretriaged items against maxItemsPerRun first, then fills the rest with new items", async () => {
    const llm = fakeLlm();
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerRun: 4 } }), items(3), {
      pretriaged: items(2, 10),
    });
    expect(llm.of("triage").map((c) => c.titles)).toEqual([["Title 1", "Title 2"]]);
    expect(titles(result.undecided)).toEqual(["Title 3"]);
    expect(result.insights).toHaveLength(4);
  });

  it("keeps the oldest pretriaged items pending when they alone exceed maxItemsPerRun", async () => {
    const llm = fakeLlm();
    const pretriaged = [item(10, { publishedAt: "2026-10-01T00:00:00Z" }), item(11, { publishedAt: "2026-10-20T00:00:00Z" })];
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerRun: 1 } }), items(2), {
      pretriaged,
    });
    expect(llm.of("triage")).toHaveLength(0);
    expect(llm.of("analyze").map((c) => c.titles)).toEqual([["Title 11"]]);
    expect(titles(result.pending)).toEqual(["Title 10"]);
    expect(titles(result.undecided)).toEqual(["Title 1", "Title 2"]);
  });

  it("leaves pretriaged items pending when analyze fails", async () => {
    const llm = fakeLlm({ analyze: () => fail("transport") });
    const result = await filterAndAnalyze(llm.client, makeContext(), [], { pretriaged: items(2), retryDelayMs: 0 });
    expect(result.pending).toHaveLength(2);
    expect(result.error?.kind).toBe("transport");
  });
});

describe("filterAndAnalyze minImpact and order", () => {
  const impacts: Record<string, Impact> = { "Title 1": "Low", "Title 2": "High", "Title 3": "Medium" };

  it("records items below minImpact as irrelevant", async () => {
    const llm = fakeLlm({ analyze: insightAll((t) => impacts[t]!) });
    const result = await filterAndAnalyze(llm.client, makeContext({ minImpact: "Medium" }), items(3));
    expect(titles(result.insights.map((i) => i.item))).toEqual(["Title 2", "Title 3"]);
    expect(titles(result.irrelevant)).toEqual(["Title 1"]);
  });

  it("keeps only High with minImpact High", async () => {
    const llm = fakeLlm({ analyze: insightAll((t) => impacts[t]!) });
    const result = await filterAndAnalyze(llm.client, makeContext({ minImpact: "High" }), items(3));
    expect(titles(result.insights.map((i) => i.item))).toEqual(["Title 2"]);
  });

  it("sorts by impact, then newest first, with undated items last", async () => {
    const list = [
      item(1, { publishedAt: "2026-10-20T00:00:00Z" }),
      item(2),
      item(3, { publishedAt: "2026-10-25T00:00:00Z" }),
      item(4, { publishedAt: "Sat, 24 Oct 2026 10:00:00 +0000" }),
      item(5),
      item(6, { publishedAt: "2026-10-01T00:00:00Z" }),
    ];
    const byTitle: Record<string, Impact> = {
      "Title 1": "Medium",
      "Title 2": "Medium",
      "Title 3": "Medium",
      "Title 4": "High",
      "Title 5": "Medium",
      "Title 6": "High",
    };
    const llm = fakeLlm({ analyze: insightAll((t) => byTitle[t]!) });
    const result = await filterAndAnalyze(llm.client, makeContext(), list);
    expect(titles(result.insights.map((i) => i.item))).toEqual([
      "Title 4",
      "Title 6",
      "Title 3",
      "Title 1",
      "Title 2",
      "Title 5",
    ]);
  });
});
