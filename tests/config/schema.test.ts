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
      notify: { minImpact: "Low", postWhenEmpty: false, channels: [{ type: "slack" }] },
      state: { ttlDays: 45 },
      schedule: { interval: "daily" },
    });
  });

  it("accepts dependabot-style schedules, with day as a list too", () => {
    const parse = (schedule: unknown) => ContextSchema.parse({ ...minimalContext, schedule }).schedule;
    expect(parse({ interval: "weekly", day: ["monday", "thursday"], time: "07:30", timezone: "Asia/Tokyo" })).toEqual({
      interval: "weekly",
      day: ["monday", "thursday"],
      time: "07:30",
      timezone: "Asia/Tokyo",
    });
    expect(parse({ interval: "cron", cronjob: "0 8 * * 1-5" })).toEqual({ interval: "cron", cronjob: "0 8 * * 1-5" });
  });

  it("rejects schedule keys that do not fit the interval, and bad values", () => {
    const errors = (schedule: unknown) => contextErrors({ ...minimalContext, schedule });
    expect(errors({ day: "monday" })).toEqual(["context.yml: schedule.day: is only used with interval: weekly"]);
    expect(errors({ interval: "cron", time: "06:00" })).toEqual([
      "context.yml: schedule.time: is set by cronjob with interval: cron",
      "context.yml: schedule.cronjob: is required with interval: cron",
    ]);
    expect(errors({ cronjob: "0 6 * * *" })).toEqual(["context.yml: schedule.cronjob: is only used with interval: cron"]);
    expect(errors({ time: "6:00" })).toEqual(['context.yml: schedule.time: "6:00" is not a time (use HH:MM, 24-hour)']);
    expect(errors({ interval: "cron", cronjob: "@daily" })).toEqual([
      'context.yml: schedule.cronjob: "@daily" must have 5 fields (minute hour day-of-month month day-of-week)',
    ]);
    expect(errors({ timezone: "Mars/Olympus" })).toEqual([
      "context.yml: schedule.timezone: must be an IANA time zone such as Asia/Tokyo",
    ]);
    expect(errors({ interval: "weekly", day: [] })).toEqual(["context.yml: schedule.day: must have at least 1 item"]);
  });

  it("fills the file channel's dir and keeps the channels in order", () => {
    const parsed = ContextSchema.parse({ ...minimalContext, notify: { channels: [{ type: "file" }, { type: "slack" }] } });
    expect(parsed.notify.channels).toEqual([{ type: "file", dir: "reports" }, { type: "slack" }]);
  });

  it("rejects no channels, a repeated channel type and an unknown one", () => {
    const errors = (channels: unknown[]) => contextErrors({ ...minimalContext, notify: { channels } });
    expect(errors([])).toEqual(["context.yml: notify.channels: must have at least 1 item"]);
    expect(errors([{ type: "file" }, { type: "file", dir: "out" }])).toEqual([
      "context.yml: notify.channels[1].type: duplicate type",
    ]);
    expect(errors([{ type: "email" }])).toEqual(["context.yml: notify.channels[0].type: invalid option"]);
    // The webhook is read from the environment only, so it has no key here.
    expect(errors([{ type: "slack", webhookUrl: "https://hooks.slack.com/x" }])).toEqual([
      "context.yml: notify.channels[0]: unknown key",
    ]);
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
    [Array.from({ length: 51 }, (_, i) => `p${i}`), "context.yml: problems: must have at most 50 items"],
    [[" "], "context.yml: problems[0]: must not be empty"],
  ])("checks the problems list", (problems, expected) => {
    expect(contextErrors({ ...minimalContext, problems })).toEqual([expected]);
  });

  it.each([
    [{ ttlDays: 14, maxItemAgeDays: 14 }],
    [{ ttlDays: 10, maxItemAgeDays: 14 }],
  ])("requires ttlDays > maxItemAgeDays (%o)", (state) => {
    expect(contextErrors({ ...minimalContext, state })).toEqual([
      "context.yml: state.ttlDays: must be greater than maxItemAgeDays",
    ]);
  });

  it.each(["auto", "api", "cli", "claude", "codex"])("accepts llm.provider %s", (provider) => {
    expect(contextErrors({ ...minimalContext, llm: { provider } })).toEqual([]);
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
      defaults: { itemsPerFeed: 3, maxItemsPerFeed: 20, maxContentChars: 2000 },
      feeds: [{ ...gh, feed: "releases", includePrereleases: false }],
      queries: [{ id: "q", query: "x", topic: "general", maxResults: 10, requireDate: false }],
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

  it("takes domain names for a query's domain filters, lowercased", () => {
    const parsed = SourcesSchema.parse({
      version: 1,
      queries: [{ id: "q", query: "x", includeDomains: [" PRTimes.jp "], excludeDomains: ["news.example.co.uk"] }],
    });
    expect(parsed.queries[0]).toMatchObject({ includeDomains: ["prtimes.jp"], excludeDomains: ["news.example.co.uk"] });
    for (const bad of ["https://prtimes.jp", "prtimes.jp/main", "localhost", "-a.com"]) {
      expect(sourcesErrors({ version: 1, queries: [{ id: "q", query: "x", includeDomains: [bad] }] })).toEqual([
        "sources.yml: queries[0].includeDomains[0]: must be a domain name such as example.com",
      ]);
    }
    expect(sourcesErrors({ version: 1, queries: [{ id: "q", query: "x", includeDomains: [] }] })).toEqual([
      "sources.yml: queries[0].includeDomains: must have at least 1 item",
    ]);
  });

  it("bounds maxResults", () => {
    expect(sourcesErrors({ version: 1, queries: [{ id: "q", query: "x", maxResults: 21 }] })).toEqual([
      "sources.yml: queries[0].maxResults: must be <= 20",
    ]);
  });
});
