import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/load.js";
import { ExitCode } from "../../src/errors.js";
import { extractJson, parseProposal, readProposal } from "../../src/proposal/parse.js";
import { PROPOSAL_LIMITS } from "../../src/proposal/prompt.js";

const FULL = {
  pochi: "proposal/v1",
  project: { name: "pecolab", description: "Pet photos\nto illustrations" },
  language: "Japanese",
  problems: [{ text: "Next.js breaking changes", axis: "tech", evidence: "package.json: next@15.3" }],
  exclude: [{ text: "Funding news", evidence: "knowledge" }],
  repos: [{ repo: " vercel/next.js ", evidence: "package.json" }],
  sites: [{ url: "https://blog.cloudflare.com", evidence: "wrangler.toml" }],
  queries: [
    { query: "pet AI illustration app", intent: "competitor", topic: "news", evidence: "README" },
    { query: "AI copyright guideline", topic: "general" },
  ],
};

function parse(value: unknown) {
  return parseProposal(JSON.stringify(value), "p.json");
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("did not throw");
}

describe("parseProposal", () => {
  it("maps every field, cleaned", () => {
    expect(parse(FULL)).toEqual({
      project: { name: "pecolab", description: "Pet photos to illustrations" },
      language: "Japanese",
      problems: [{ text: "Next.js breaking changes", evidence: "tech · package.json: next@15.3" }],
      exclude: [{ text: "Funding news", evidence: "knowledge" }],
      repos: [{ repo: "vercel/next.js", evidence: "package.json" }],
      sites: [{ url: "https://blog.cloudflare.com/", evidence: "wrangler.toml" }],
      queries: [
        { query: "pet AI illustration app", topic: "news", evidence: "competitor · README" },
        { query: "AI copyright guideline", topic: "general", evidence: "" },
      ],
      dropped: 0,
    });
  });

  it("needs only the version tag, and ignores keys it does not know", () => {
    expect(parse({ pochi: "proposal/v1", extra: { anything: 1 }, problems: [{ text: "x", confidence: 0.9 }] })).toEqual({
      project: { name: "", description: "" },
      problems: [{ text: "x", evidence: "" }],
      exclude: [],
      repos: [],
      sites: [],
      queries: [],
      dropped: 0,
    });
  });

  it("refuses a file that is not a proposal, without quoting it", () => {
    for (const value of [{ pochi: "proposal/v2" }, { project: { name: "x" } }]) {
      const err = thrown(() => parse(value));
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).exitCode).toBe(ExitCode.CONFIG);
      expect((err as Error).message).toBe('p.json: not a Pochi proposal (expected "pochi": "proposal/v1")');
    }
    expect((thrown(() => parseProposal("sk-secret no json here", "p.md")) as Error).message).toBe(
      "p.md: no JSON proposal found",
    );
    // Only an object can be a proposal.
    expect((thrown(() => parse([FULL])) as Error).message).toBe("p.json: no JSON proposal found");
  });

  it("keeps a query's includeDomains, leaving out what is not a domain", () => {
    const result = parse({
      pochi: "proposal/v1",
      queries: [
        { query: "ペット葬儀 グッズ", includeDomains: ["PRTimes.jp", "https://x.example", 3, "prtimes.jp"] },
        { query: "no sites", includeDomains: ["not a domain"] },
        { query: "bad list", includeDomains: "prtimes.jp" },
      ],
    });
    expect(result.queries).toEqual([
      { query: "ペット葬儀 グッズ", topic: "news", evidence: "", includeDomains: ["prtimes.jp"] },
      { query: "no sites", topic: "news", evidence: "" },
      { query: "bad list", topic: "news", evidence: "" },
    ]);
  });

  it("drops malformed entries one by one and counts them", () => {
    const result = parse({
      pochi: "proposal/v1",
      problems: [{ text: "  " }, "just a string", { text: "Kept" }],
      repos: [{ repo: "next.js" }, { repo: "a/.." }, { repo: "vercel/next.js/x" }, { repo: "acme/ok" }],
      sites: [{ url: "javascript:alert(1)" }, { url: "/relative" }, { url: "https://ok.example" }],
      queries: [{ query: "" }, { query: "Kept query", topic: "weird" }],
      exclude: "not a list",
      project: "not an object",
    });
    expect(result.problems).toEqual([{ text: "Kept", evidence: "" }]);
    expect(result.repos.map((r) => r.repo)).toEqual(["acme/ok"]);
    expect(result.sites.map((s) => s.url)).toEqual(["https://ok.example/"]);
    // An unknown topic falls back to news rather than costing the query.
    expect(result.queries).toEqual([{ query: "Kept query", topic: "news", evidence: "" }]);
    expect(result.exclude).toEqual([]);
    expect(result.project).toEqual({ name: "", description: "" });
    expect(result.dropped).toBe(2 + 3 + 2 + 1);
  });

  it("cuts each list at its limit and counts the rest as dropped", () => {
    const repos = Array.from({ length: PROPOSAL_LIMITS.repos + 3 }, (_, i) => ({ repo: `acme/r${i}` }));
    const result = parse({ pochi: "proposal/v1", repos });
    expect(result.repos).toHaveLength(PROPOSAL_LIMITS.repos);
    expect(result.repos.at(-1)!.repo).toBe(`acme/r${PROPOSAL_LIMITS.repos - 1}`);
    expect(result.dropped).toBe(3);
  });

  it("strips control characters and shortens long text", () => {
    const result = parse({
      pochi: "proposal/v1",
      problems: [{ text: `\u001b[31mred\u001b[0m ${"x".repeat(300)}`, evidence: "e".repeat(200) }],
    });
    const [problem] = result.problems;
    expect(problem!.text.startsWith("[31mred[0m x")).toBe(true);
    expect(Array.from(problem!.text)).toHaveLength(200);
    expect(Array.from(problem!.evidence)).toHaveLength(120);
  });
});

describe("extractJson", () => {
  it("reads bare JSON, with a BOM and surrounding whitespace", () => {
    expect(extractJson('﻿\n  {"a": 1}\n')).toEqual({ a: 1 });
  });

  it("takes the last fenced block that parses when the JSON is wrapped in prose", () => {
    const text = [
      "I explored the repository and will end with one ```json block.",
      "```json",
      '{"draft": true}',
      "```",
      "Here is the final answer:",
      "```json",
      '{"final": true}',
      "```",
      "```",
      "not json",
      "```",
      "```json",
      "[1, 2]",
      "```",
    ].join("\n");
    expect(extractJson(text)).toEqual({ final: true });
  });

  it("prefers the last block tagged as a proposal over an example after it", () => {
    const text = [
      "```json",
      '{"pochi": "proposal/v1", "n": 1}',
      "```",
      "A sources.yml would then look like:",
      "```json",
      '{"feeds": []}',
      "```",
    ].join("\n");
    expect(extractJson(text)).toEqual({ pochi: "proposal/v1", n: 1 });
  });

  it("falls back to the fenced blocks when text starting with { is not JSON as a whole", () => {
    expect(extractJson('{"pochi": "proposal/v1"}\n\nLet me know if you want more.')).toBeUndefined();
    expect(extractJson('{inline} first, then:\n```json\n{"pochi": "proposal/v1"}\n```')).toEqual({ pochi: "proposal/v1" });
  });

  it("returns undefined for broken or missing JSON", () => {
    expect(extractJson('{"a": ')).toBeUndefined();
    expect(extractJson("no fences here")).toBeUndefined();
    expect(extractJson("```json\n{broken\n```")).toBeUndefined();
  });
});

describe("readProposal", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pochi-proposal-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a Markdown answer saved from an agent", async () => {
    const path = join(dir, "proposal.md");
    await writeFile(path, `Done.\n\n\`\`\`json\n${JSON.stringify(FULL, null, 2)}\n\`\`\`\n`);
    expect((await readProposal(path)).repos).toEqual([{ repo: "vercel/next.js", evidence: "package.json" }]);
  });

  it("fails with a config error when the file is missing or too large", async () => {
    const missing = join(dir, "missing.json");
    await expect(readProposal(missing)).rejects.toMatchObject({
      exitCode: ExitCode.CONFIG,
      message: `cannot read the proposal ${missing}`,
    });
    const big = join(dir, "big.json");
    await writeFile(big, JSON.stringify({ pochi: "proposal/v1", pad: "x".repeat(256 * 1024) }));
    await expect(readProposal(big)).rejects.toMatchObject({ message: `the proposal ${big} is larger than 256 KB` });
  });

  it("refuses what is not a regular file before reading it", async () => {
    await expect(readProposal(dir)).rejects.toMatchObject({ message: `cannot read the proposal ${dir}` });
  });
});
