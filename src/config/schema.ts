import { z } from "zod";
import { parseHttpUrl } from "../util/hash.js";
import { plural } from "../util/text.js";

const text = z.string().trim().min(1);
const sourceId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, { error: "must be lowercase letters, digits, - or _" });
const positiveInt = z.int().positive();

export const ImpactSchema = z.enum(["High", "Medium", "Low"]);
export type Impact = z.output<typeof ImpactSchema>;

export const ContextSchema = z
  .strictObject({
    version: z.literal(1),
    project: z.strictObject({ name: text, description: z.string() }),
    problems: z.array(text).min(1).max(20),
    exclude: z.array(text).max(30).default([]),
    language: text.default("English"),
    llm: z
      .strictObject({
        provider: z.enum(["auto", "api", "cli"]).default("auto"),
        // null and omitted both mean "use the mode's default"; the adapter resolves it.
        triageModel: text.nullish(),
        analyzeModel: text.nullish(),
        maxItemsPerCall: positiveInt.default(40),
        maxItemsPerRun: positiveInt.default(150),
      })
      .prefault({}),
    notify: z
      .strictObject({
        slack: z
          .strictObject({
            postWhenEmpty: z.boolean().default(false),
            minImpact: ImpactSchema.default("Low"),
          })
          .prefault({}),
      })
      .prefault({}),
    state: z
      .strictObject({
        ttlDays: positiveInt.default(45),
        maxItemAgeDays: positiveInt.default(14),
      })
      .prefault({})
      // Otherwise an expired entry could reappear as a new item while still in its feed window.
      .refine((s) => s.ttlDays > s.maxItemAgeDays, {
        error: "must be greater than maxItemAgeDays",
        path: ["ttlDays"],
      }),
  });

const GithubFeedSchema = z.strictObject({
  id: sourceId,
  type: z.literal("github"),
  name: text,
  // Owners cannot contain dots; repos may start with one (.github) but "." and ".." would escape the API path.
  repo: z.string().regex(/^[\w-]+\/(?!\.\.?$)[\w.-]+$/, { error: "must be owner/repo" }),
  feed: z.enum(["releases", "tags"]).default("releases"),
  includePrereleases: z.boolean().default(false),
});

const RssFeedSchema = z.strictObject({
  id: sourceId,
  type: z.literal("rss"),
  name: text,
  url: z.string().refine((u) => parseHttpUrl(u) !== undefined, { error: "must be an absolute http(s) URL" }),
});

const QuerySchema = z.strictObject({
  id: sourceId,
  query: text,
  topic: z.enum(["news", "general"]).default("general"),
  maxResults: positiveInt.max(20).default(5),
});

export const SourcesSchema = z
  .strictObject({
    version: z.literal(1),
    defaults: z
      .strictObject({
        itemsPerFeed: positiveInt.default(3),
        maxContentChars: positiveInt.default(2000),
      })
      .prefault({}),
    feeds: z.array(z.discriminatedUnion("type", [GithubFeedSchema, RssFeedSchema])).default([]),
    queries: z.array(QuerySchema).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.feeds.length + s.queries.length === 0) {
      ctx.addIssue({ code: "custom", message: "at least one feed or query is required", path: [] });
    }
    // Item ids are derived from the source id, so ids must be unique across feeds and queries.
    const seen = new Set<string>();
    const entries = [
      ...s.feeds.map((f, i) => ["feeds", i, f.id] as const),
      ...s.queries.map((q, i) => ["queries", i, q.id] as const),
    ];
    for (const [list, i, id] of entries) {
      if (seen.has(id)) ctx.addIssue({ code: "custom", message: "duplicate id", path: [list, i, "id"] });
      seen.add(id);
    }
  });

export type Context = z.output<typeof ContextSchema>;
export type ContextInput = z.input<typeof ContextSchema>;
export type Sources = z.output<typeof SourcesSchema>;
export type SourcesInput = z.input<typeof SourcesSchema>;
export type FeedConfig = Sources["feeds"][number];
export type GithubFeed = Extract<FeedConfig, { type: "github" }>;
export type RssFeed = Extract<FeedConfig, { type: "rss" }>;
export type QueryConfig = Sources["queries"][number];

// Config may hold secrets pasted in the wrong place, so messages are rebuilt from the issue
// code: zod's own messages and the input never reach the output, not even unknown key names.
export function formatIssues(issues: readonly z.core.$ZodIssue[], label: string): string[] {
  return issues.map((issue) => `${label}: ${formatPath(issue.path)}: ${describeIssue(issue)}`);
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : `${i === 0 ? "" : "."}${String(p)}`)).join("");
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "too_small":
      return describeBound(issue.origin, "at least", issue.minimum, issue.inclusive);
    case "too_big":
      return describeBound(issue.origin, "at most", issue.maximum, issue.inclusive);
    case "invalid_value":
    case "invalid_union":
      return "invalid option";
    case "unrecognized_keys":
      return issue.keys.length === 1 ? "unknown key" : `${issue.keys.length} unknown keys`;
    case "invalid_format":
    case "custom":
      // Only our own refinements produce these, and their messages never include the value.
      return issue.message;
    default:
      return "invalid value";
  }
}

function describeBound(origin: string, word: string, bound: number | bigint, inclusive = true): string {
  const n = Number(bound);
  switch (origin) {
    case "array":
      return `must have ${word} ${plural(n, "item")}`;
    case "string":
      return n === 1 && word === "at least" ? "must not be empty" : `must be ${word} ${n} characters`;
    default:
      return `must be ${word === "at least" ? (inclusive ? ">=" : ">") : inclusive ? "<=" : "<"} ${n}`;
  }
}
