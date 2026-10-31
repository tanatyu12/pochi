import { z } from "zod";
import { CalendarError, WEEKDAYS, isTimeZone, parseCron, parseTime } from "../schedule/calendar.js";
import { parseHttpUrl } from "../util/hash.js";
import { plural } from "../util/text.js";

const text = z.string().trim().min(1);
const sourceId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, { error: "must be lowercase letters, digits, - or _" });
const positiveInt = z.int().positive();

// Owners cannot contain dots; repos may start with one (.github) but "." and ".." would escape the API path.
export const REPO_PATTERN = /^[\w-]+\/(?!\.\.?$)[\w.-]+$/;

export const ImpactSchema = z.enum(["High", "Medium", "Low"]);
export type Impact = z.output<typeof ImpactSchema>;

// The webhook is a secret, so it is read from SLACK_WEBHOOK_URL only and never written here.
const SlackChannelSchema = z.strictObject({ type: z.literal("slack") });

const FileChannelSchema = z.strictObject({
  type: z.literal("file"),
  /** Relative paths are taken from the working directory, like config/ and state/. */
  dir: text.default("reports"),
});

const WeekdaySchema = z.enum(WEEKDAYS);

// Named and shaped after dependabot's schedule, with day also taking a list.
const ScheduleSchema = z
  .strictObject({
    interval: z.enum(["daily", "weekly", "monthly", "cron"]).default("daily"),
    day: z.union([WeekdaySchema, z.array(WeekdaySchema).min(1)]).optional(),
    time: z.string().optional(),
    /** IANA name; omitted means the machine's zone (UTC for the github backend). */
    timezone: z.string().refine(isTimeZone, { error: "must be an IANA time zone such as Asia/Tokyo" }).optional(),
    cronjob: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (s.day !== undefined && s.interval !== "weekly") issue("day", "is only used with interval: weekly");
    if (s.interval === "cron") {
      if (s.time !== undefined) issue("time", "is set by cronjob with interval: cron");
      if (s.cronjob === undefined) issue("cronjob", "is required with interval: cron");
    } else if (s.cronjob !== undefined) {
      issue("cronjob", "is only used with interval: cron");
    }
    for (const [key, check] of [
      ["time", parseTime],
      ["cronjob", parseCron],
    ] as const) {
      const value = s[key];
      if (value === undefined) continue;
      try {
        check(value);
      } catch (err) {
        if (!(err instanceof CalendarError)) throw err;
        issue(key, err.message);
      }
    }
  });

export const ContextSchema = z
  .strictObject({
    version: z.literal(1),
    project: z.strictObject({ name: text, description: z.string() }),
    problems: z.array(text).min(1).max(20),
    exclude: z.array(text).max(30).default([]),
    language: text.default("English"),
    llm: z
      .strictObject({
        // cli is claude, as it was before codex was supported.
        provider: z.enum(["auto", "api", "cli", "claude", "codex"]).default("auto"),
        // null and omitted both mean "use the mode's default"; the adapter resolves it. For codex
        // that is codex's own configured model.
        triageModel: text.nullish(),
        analyzeModel: text.nullish(),
        maxItemsPerCall: positiveInt.default(40),
        maxItemsPerRun: positiveInt.default(150),
      })
      .prefault({}),
    notify: z
      .strictObject({
        minImpact: ImpactSchema.default("Low"),
        postWhenEmpty: z.boolean().default(false),
        channels: z
          .array(z.discriminatedUnion("type", [SlackChannelSchema, FileChannelSchema]))
          .min(1)
          .default([{ type: "slack" }])
          .superRefine((channels, ctx) => {
            // Each type takes its settings from one place (Slack from SLACK_WEBHOOK_URL), so a second is a mistake.
            const seen = new Set<string>();
            for (const [i, c] of channels.entries()) {
              if (seen.has(c.type)) ctx.addIssue({ code: "custom", message: "duplicate type", path: [i, "type"] });
              seen.add(c.type);
            }
          }),
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
    schedule: ScheduleSchema.prefault({}),
  });

const GithubFeedSchema = z.strictObject({
  id: sourceId,
  type: z.literal("github"),
  name: text,
  repo: z.string().regex(REPO_PATTERN, { error: "must be owner/repo" }),
  feed: z.enum(["releases", "tags"]).default("releases"),
  includePrereleases: z.boolean().default(false),
});

const RssFeedSchema = z.strictObject({
  id: sourceId,
  type: z.literal("rss"),
  name: text,
  url: z.string().refine((u) => parseHttpUrl(u) !== undefined, { error: "must be an absolute http(s) URL" }),
});

// A bare host name such as prtimes.jp, the form Tavily's domain filters take.
export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/, {
    error: "must be a domain name such as example.com",
  });
export const MAX_DOMAINS = 20;
const domains = z.array(DomainSchema).min(1).max(MAX_DOMAINS).optional();

const QuerySchema = z.strictObject({
  id: sourceId,
  query: text,
  topic: z.enum(["news", "general"]).default("general"),
  maxResults: positiveInt.max(20).default(10),
  /** Drop results Tavily cannot date, rather than leave their age to the LLM. */
  requireDate: z.boolean().default(false),
  /** Search only these sites, such as a press release wire for news no feed carries. */
  includeDomains: domains,
  excludeDomains: domains,
});

export const SourcesSchema = z
  .strictObject({
    version: z.literal(1),
    defaults: z
      .strictObject({
        itemsPerFeed: positiveInt.default(3),
        /** Entries published since the last run are taken beyond itemsPerFeed, up to this many. */
        maxItemsPerFeed: positiveInt.default(20),
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
export type ChannelConfig = Context["notify"]["channels"][number];
export type Schedule = Context["schedule"];

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
