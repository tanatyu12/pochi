import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { ANALYZE_BATCH_SIZE, filterAndAnalyze } from "../../src/pipeline/filter.js";
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

afterEach(() => resetLog());

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
    expect(result.stats).toEqual({ triageBatches: 3, triageFailed: 0, analyzeBatches: 2, analyzeFailed: 0 });
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

  it("leaves items without an insight undecided", async () => {
    const llm = fakeLlm({
      analyze: (call) => ({
        insights: [{ id: call.ids[1], title: "t", summary: "s", impact: "High", action: "a" }],
      }),
    });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(3));
    expect(titles(result.insights.map((i) => i.item))).toEqual(["Title 2"]);
    expect(titles(result.undecided)).toEqual(["Title 1", "Title 3"]);
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
  it("retries a failed batch once", async () => {
    const llm = fakeLlm({ triage: (call, n) => (n === 0 ? fail("rate_limit") : relevantAll(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(2));
    expect(llm.of("triage")).toHaveLength(2);
    expect(result.insights).toHaveLength(2);
    expect(result.stats.triageFailed).toBe(0);
  });

  it("leaves a batch that fails twice undecided and carries on", async () => {
    // Batch 2 (calls 1 and 2) fails both times; batches 1 and 3 succeed.
    const llm = fakeLlm({ triage: (call, n) => (n === 1 || n === 2 ? fail() : relevantAll(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(6));
    expect(llm.of("triage")).toHaveLength(4);
    expect(titles(result.undecided)).toEqual(["Title 3", "Title 4"]);
    expect(result.insights).toHaveLength(4);
    expect(result.stats).toMatchObject({ triageBatches: 3, triageFailed: 1 });
    expect(logs.join("")).toContain("triage batch 2/3 failed");
  });

  it.each(["auth", "unavailable"] as const)("stops calling after %s, without retrying", async (kind) => {
    const llm = fakeLlm({ triage: (call, n) => (n === 1 ? fail(kind) : relevantAll(call, n)) });
    const promise = filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(6));
    // Batch 1 succeeded, but analyze has no call left to make, so the run has nothing to send.
    const err = await promise.then(
      () => expect.unreachable("expected a rejection"),
      (e: unknown) => e as LlmError,
    );
    expect(err.kind).toBe(kind);
    expect(llm.of("triage")).toHaveLength(2);
    expect(llm.of("analyze")).toHaveLength(0);
  });

  it("throws exit 3 when every triage batch fails", async () => {
    const llm = fakeLlm({ triage: () => fail("timeout") });
    const err = await filterAndAnalyze(llm.client, makeContext({ llm: { maxItemsPerCall: 2 } }), items(3)).then(
      () => expect.unreachable("expected a rejection"),
      (e: unknown) => e as LlmError,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe("timeout");
    expect(exitCodeOf(err)).toBe(ExitCode.LLM);
    expect(err.message).toContain("all 2 batches failed");
    expect(llm.of("triage")).toHaveLength(4);
  });

  it("throws exit 3 when every analyze batch fails", async () => {
    const llm = fakeLlm({ analyze: () => fail("invalid_output") });
    const err = await filterAndAnalyze(llm.client, makeContext(), items(3)).then(
      () => expect.unreachable("expected a rejection"),
      (e: unknown) => e as LlmError,
    );
    expect(err.kind).toBe("invalid_output");
    expect(err.message).toContain("analyze: the only batch failed");
  });

  it("does not throw when analyze only partly fails", async () => {
    const llm = fakeLlm({ analyze: (call, n) => (n < 2 ? fail() : insightAll()(call, n)) });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(20));
    expect(result.stats).toMatchObject({ analyzeBatches: 2, analyzeFailed: 1 });
    expect(result.undecided).toHaveLength(15);
    expect(result.insights).toHaveLength(5);
  });

  it("does not call analyze when nothing is relevant", async () => {
    const llm = fakeLlm({ triage: (call) => ({ decisions: call.ids.map((id) => ({ id, relevant: false, reason: "r" })) }) });
    const result = await filterAndAnalyze(llm.client, makeContext(), items(3));
    expect(llm.of("analyze")).toHaveLength(0);
    expect(result.irrelevant).toHaveLength(3);
    expect(result.stats.analyzeBatches).toBe(0);
  });

  it("throws the abort reason without retrying", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const llm = fakeLlm({
      triage: () => {
        controller.abort(reason);
        fail("transport");
      },
    });
    await expect(filterAndAnalyze(llm.client, makeContext(), items(2), { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(llm.calls).toHaveLength(1);
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
