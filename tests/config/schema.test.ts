import { describe, expect, it } from "vitest";
import { ContextSchema, SourcesSchema, formatIssues } from "../../src/config/schema.js";

const minimalContext = { version: 1, project: { name: "app", description: "" }, problems: ["p"] };
const rss = { id: "blog", type: "rss", name: "Blog", url: "https://example.com/feed" };
const minimalSources = { version: 1, feeds: [rss] };

function contextErrors(input: unknown): string[] {
  const r = ContextSchema.safeParse(input);
  return r.success ? [] : formatIssues(r.error.issues, "context.yml");
}

function sourcesErrors(input: unknown): string[] {
  const r = SourcesSchema.safeParse(input);
  return r.success ? [] : formatIssues(r.error.issues, "sources.yml");
}

describe("ContextSchema", () => {
  it("fills defaults for a minimal context", () => {
    expect(ContextSchema.parse(minimalContext)).toEqual({
      ...minimalContext,
      exclude: [],
      language: "English",
      llm: { provider: "auto", maxItemsPerCall: 40, maxItemsPerRun: 150 },
      notify: { slack: { postWhenEmpty: false, minImpact: "Low" } },
      state: { ttlDays: 45, maxItemAgeDays: 14 },
    });
  });

  it.each([null, undefined, "claude-haiku-5-5"])("accepts triageModel %s", (triageModel) => {
    const parsed = ContextSchema.parse({ ...minimalContext, llm: { triageModel } });
    expect(parsed.llm.triageModel).toBe(triageModel);
  });

  it("rejects unknown keys", () => {
    expect(contextErrors({ ...minimalContext, extra: 1 })).toEqual(["context.yml: (root): unknown key"]);
    expect(contextErrors({ ...minimalContext, llm: { model: "x" } })).toEqual(["context.yml: llm: unknown key"]);
  });

  it.each([
    [[], "context.yml: problems: must have at least 1 item"],
    [Array.from({ length: 21 }, (_, i) => `p${i}`), "context.yml: problems: must have at most 20 items"],
    [[" "], "context.yml: problems[0]: must not be empty"],
  ])("checks the problems list", (problems, expected) => {
    expect(contextErrors({ ...minimalContext, problems })).toEqual([expected]);
  });

  it.each([
    [{ ttlDays: 14, maxItemAgeDays: 14 }],
    [{ ttlDays: 10 }],
  ])("requires ttlDays > maxItemAgeDays (%o)", (state) => {
    expect(contextErrors({ ...minimalContext, state })).toEqual([
      "context.yml: state.ttlDays: must be greater than maxItemAgeDays",
    ]);
  });

  it("describes wrong types, enums and numeric bounds", () => {
    expect(
      contextErrors({
        version: 2,
        project: { name: 1, description: "" },
        problems: ["p"],
        llm: { provider: "gpt", maxItemsPerCall: 0 },
      }),
    ).toEqual([
      "context.yml: version: invalid option",
      "context.yml: project.name: expected string",
      "context.yml: llm.provider: invalid option",
      "context.yml: llm.maxItemsPerCall: must be > 0",
    ]);
  });
});

describe("SourcesSchema", () => {
  it("fills defaults for a minimal sources file", () => {
    const gh = { id: "next", type: "github", name: "Next", repo: "vercel/next.js" };
    expect(SourcesSchema.parse({ version: 1, feeds: [gh], queries: [{ id: "q", query: "x" }] })).toEqual({
      version: 1,
      defaults: { itemsPerFeed: 3, maxContentChars: 500 },
      feeds: [{ ...gh, feed: "releases", includePrereleases: false }],
      queries: [{ id: "q", query: "x", topic: "general", maxResults: 5 }],
    });
  });

  it("requires at least one feed or query", () => {
    expect(sourcesErrors({ version: 1 })).toEqual(["sources.yml: (root): at least one feed or query is required"]);
    expect(sourcesErrors({ version: 1, queries: [{ id: "q", query: "x" }] })).toEqual([]);
  });

  it("rejects duplicate ids within feeds and across feeds and queries", () => {
    expect(sourcesErrors({ version: 1, feeds: [rss, rss] })).toEqual(["sources.yml: feeds[1].id: duplicate id"]);
    expect(sourcesErrors({ version: 1, feeds: [rss], queries: [{ id: "blog", query: "x" }] })).toEqual([
      "sources.yml: queries[0].id: duplicate id",
    ]);
  });

  it.each([
    [{ ...rss, url: "ftp://example.com/feed" }, "sources.yml: feeds[0].url: must be an absolute http(s) URL"],
    [{ ...rss, url: "/feed" }, "sources.yml: feeds[0].url: must be an absolute http(s) URL"],
    [{ ...rss, id: "Blog" }, "sources.yml: feeds[0].id: must be lowercase letters, digits, - or _"],
    [{ id: "gh", type: "github", name: "x", repo: "next.js" }, "sources.yml: feeds[0].repo: must be owner/repo"],
    [{ id: "gh", type: "github", name: "x", repo: "../.." }, "sources.yml: feeds[0].repo: must be owner/repo"],
    [{ id: "gh", type: "github", name: "x", repo: "x/.." }, "sources.yml: feeds[0].repo: must be owner/repo"],
    [{ id: "gh", type: "github", name: "x", repo: "x/." }, "sources.yml: feeds[0].repo: must be owner/repo"],
    [{ id: "gh", type: "github", name: "x", repo: "./x" }, "sources.yml: feeds[0].repo: must be owner/repo"],
    [{ id: "gh", type: "github", name: "x", repo: "a.b/c" }, "sources.yml: feeds[0].repo: must be owner/repo"],
    [{ ...rss, type: "atom" }, "sources.yml: feeds[0].type: invalid option"],
  ])("rejects an invalid feed %o", (feed, expected) => {
    expect(sourcesErrors({ version: 1, feeds: [feed] })).toEqual([expected]);
  });

  it.each(["vercel/next.js", "org/.github", "my_org/repo-name"])("accepts the github repo %s", (repo) => {
    expect(sourcesErrors({ version: 1, feeds: [{ id: "gh", type: "github", name: "x", repo }] })).toEqual([]);
  });

  it("rejects github-only keys on an rss feed", () => {
    expect(sourcesErrors({ version: 1, feeds: [{ ...rss, repo: "a/b" }] })).toEqual([
      "sources.yml: feeds[0]: unknown key",
    ]);
  });

  it("bounds maxResults", () => {
    expect(sourcesErrors({ version: 1, queries: [{ id: "q", query: "x", maxResults: 21 }] })).toEqual([
      "sources.yml: queries[0].maxResults: must be <= 20",
    ]);
  });
});
