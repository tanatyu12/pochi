import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigError, configEnvOverrides, DEFAULT_CONFIG_DIR, parseContext } from "../config/load.js";
import {
  type Context,
  type ChannelConfig,
  type ContextInput,
  ContextSchema,
  DomainSchema,
  MAX_PROBLEMS,
  REPO_PATTERN,
  type Schedule,
  type SourcesInput,
  SourcesSchema,
} from "../config/schema.js";
import { existingConfig, writeConfig } from "../config/write.js";
import { resolveLlm } from "../llm/adapter.js";
import {
  MAX_IDEAS,
  MAX_IDEA_QUERIES,
  MAX_IDEA_SITES,
  MAX_QUERY_SUGGESTIONS,
  MAX_REPO_CANDIDATES,
  ideaSuggestionRequest,
  queryId,
  querySuggestionRequest,
  repoInferenceRequest,
} from "../llm/prompts.js";
import { type IdeaSuggestionOutput, type LlmClient, LlmError } from "../llm/schema.js";
import { type Proposal, type ProposedText, readProposal } from "../proposal/parse.js";
import { EMPTY_WATCHLIST, type Watchlist, discoveryPrompt } from "../proposal/prompt.js";
import { CalendarError, DEFAULT_TIME, calendarOf, describeSchedule, nextRuns, parseTime, type Weekday } from "../schedule/calendar.js";
import { type ScheduleDeps, installSchedule, runsFromBundle } from "./schedule.js";
import { type DiscoveredFeed, FeedCheckError, discoverFeeds, isTransient } from "../sources/discover.js";
import { type RepoCheck, verifyRepo } from "../sources/github.js";
import { type SourceConfig, type SourceOutcome, fetchEach, sourceConfigs, sourceInfo } from "../sources/index.js";
import { FeedParseError } from "../sources/rss.js";
import { tavilyApiKey } from "../sources/tavily.js";
import { pLimit } from "../util/concurrency.js";
import { normalizeUrl, parseHttpUrl, sha256Hex } from "../util/hash.js";
import { HttpError } from "../util/http.js";
import { configureLog } from "../util/log.js";
import { type Prompter, PromptBack, PromptCancelled, createClackPrompter } from "../util/prompter.js";
import { replayingPrompter } from "../util/replay.js";
import { createInitCache } from "./initCache.js";
import type { Item } from "../types.js";
import { collapseWhitespace, displayLine, plural, stripControlChars } from "../util/text.js";

const MAX_EXCLUDE = 30;
const MAX_TYPED_QUERIES = 10;
// Tavily's free plan, per month.
const TAVILY_FREE_CREDITS = 1000;
// Each check is one or two GitHub API calls; a proposal can name 15 repositories at once.
const GITHUB_CONCURRENCY = 4;
// Each looks at one page and the feeds it leads to; a proposal can name 8 sites.
const SITE_CONCURRENCY = 4;
// Titles, notes and errors come from feeds, the model and the network; one line each is enough.
const SHOWN_MAX_CHARS = 120;
const HINT_MAX_CHARS = 60;
const QUERY_ID_MAX_CHARS = 32;
// An option value no repo or feed URL can take.
const NONE = "none";

export interface InitDeps {
  prompter: Prompter;
  isInteractive: () => boolean;
  /**
   * For each path (all in one directory): true or false when git can tell, undefined when it
   * cannot (no git, not a repository).
   */
  checkIgnored: (paths: string[]) => Promise<(boolean | undefined)[]>;
  env: NodeJS.ProcessEnv;
  resolveLlm: typeof resolveLlm;
  /** Aborted by Ctrl-C while something is fetched; prompts handle their own Ctrl-C. */
  signal?: AbortSignal;
  /** Receives the prompt for --print-prompt. Defaults to stdout. */
  stdout?: (s: string) => void;
  /** The machine's time zone, written as schedule.timezone. */
  timeZone?: string;
  /** For the Tavily estimate, which counts the runs in the next 30 days. */
  now?: () => Date;
  /** For installing the schedule at the end; output goes to the prompter. */
  schedule?: ScheduleDeps;
}

type FeedInput = NonNullable<SourcesInput["feeds"]>[number];
type QueryInput = NonNullable<SourcesInput["queries"]>[number];
type FoundRepo = Extract<RepoCheck, { status: "found" }>;
type QuerySuggestion = {
  query: string;
  topic: NonNullable<QueryInput["topic"]>;
  hint?: string;
  includeDomains?: string[];
  /** From the proposal or an idea the user picked, so picked to begin with when it is free. */
  proposed?: boolean;
};
/** Settles either way, so nobody has to wait for it until Claude is needed. */
type LlmLookup = Promise<{ client: LlmClient } | { error: unknown }>;

export interface InitOptions {
  configDir?: string;
  /** A proposal an agent wrote from the project (see --print-prompt), used as the defaults. */
  from?: string;
  /** Print the prompt that asks an agent for a proposal, and ask nothing. */
  printPrompt?: boolean;
  /** Who to follow (--competitor, --adopter, --news-site); every list may be empty or left out. */
  watch?: Partial<Watchlist>;
}

const MAX_WATCHED = 10;

/** Cleans the names and checks the news sites; ConfigError (exit 2) for a site that is not a domain. */
export function cleanWatchlist(watch: Partial<Watchlist> = {}): Watchlist {
  const names = (list: string[] = [], flag: string) => {
    const seen = new Set<string>();
    const kept = list.map(cleanQuery).filter((n) => n !== "" && once(seen, n.toLowerCase()));
    if (kept.length > MAX_WATCHED) throw new ConfigError(`${flag} can be given at most ${MAX_WATCHED} times`);
    return kept;
  };
  const sites = names(watch.newsSites, "--news-site").map((site) => {
    const parsed = DomainSchema.safeParse(site);
    if (!parsed.success) throw new ConfigError(`--news-site must be a domain name such as example.com`);
    return parsed.data;
  });
  return {
    competitors: names(watch.competitors, "--competitor"),
    adopters: names(watch.adopters, "--adopter"),
    newsSites: [...new Set(sites)],
  };
}

export async function runInit(opts: InitOptions = {}, deps: Partial<InitDeps> = {}): Promise<void> {
  const watch = cleanWatchlist(opts.watch);
  if (opts.printPrompt) {
    if (opts.from !== undefined) throw new ConfigError("--print-prompt and --from cannot be used together");
    // Asks nothing, so it works in a pipe: init --print-prompt | claude -p ...
    (deps.stdout ?? ((s: string) => void process.stdout.write(s)))(discoveryPrompt(watch));
    return;
  }
  const isInteractive = deps.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  // Checked before anything is shown: a piped or CI run would otherwise hang on the first question.
  if (!isInteractive()) {
    throw new ConfigError("pochi init needs an interactive terminal; copy config/*.example.yml instead");
  }
  // Read before the first question, so a file that cannot be used is reported before any is asked.
  const proposal = opts.from === undefined ? undefined : await readProposal(opts.from);
  // The prompts show what matters; info lines from the fetchers would only break up the screen.
  const restoreLog = configureLog({ level: "quiet" });
  // Shift+Tab goes back a question by running init again with the answers so far replayed; what
  // it fetches and asks Claude is cached, so a replay repeats nothing.
  const prompter = replayingPrompter(deps.prompter ?? createClackPrompter());
  const cache = createInitCache(deps.resolveLlm ?? resolveLlm, deps.signal);
  const restoreFetch = cache.installFetch();
  try {
    for (;;) {
      cache.newRun();
      try {
        await init(opts.configDir ?? DEFAULT_CONFIG_DIR, { ...deps, prompter, resolveLlm: cache.resolveLlm }, proposal, watch);
        return;
      } catch (err) {
        if (!(err instanceof PromptBack)) throw err;
        prompter.back();
      }
    }
  } finally {
    restoreFetch();
    cache.close();
    restoreLog();
  }
}

async function init(
  dir: string,
  deps: Partial<InitDeps>,
  proposal: Proposal | undefined,
  watch: Watchlist,
): Promise<void> {
  const p = deps.prompter ?? createClackPrompter();
  const checkIgnored = deps.checkIgnored ?? gitCheckIgnored;
  const env = deps.env ?? process.env;
  const { signal } = deps;

  p.intro("pochi init  (Shift+Tab: back · Esc: quit)");
  // Asked first so nobody answers every question only to be refused at the end.
  const existing = await existingConfig(dir);
  if (existing.length > 0) {
    const overwrite = await p.confirm({ message: `Overwrite ${existing.join(" and ")}?`, initialValue: false });
    if (!overwrite) throw new PromptCancelled();
  }
  // init asks for the channels and schedule again, so an overwrite would otherwise drop the ones set before.
  const previous = await readPrevious(dir);
  if (proposal) noteProposal(p, proposal);

  let contextInput = await askContext(p, proposal, previous?.notify.channels);
  // Before the sources, so the Tavily step can say what web searches cost at this schedule.
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  contextInput = { ...contextInput, schedule: await askSchedule(p, previous?.schedule, timeZone) };
  // The prompts read the defaults (language, llm) the parsed context fills in.
  let context = ContextSchema.parse(contextInput);
  const runs = runsPerMonth(context.schedule, timeZone, deps.now?.() ?? new Date());
  // Looked for while the sources are asked (the CLI probe can take seconds), and only waited
  // for by a step that needs Claude. Stopped once the answers are in, so no probe outlives init.
  const lookup = new AbortController();
  const llm = lookUpLlm(
    deps.resolveLlm ?? resolveLlm,
    context,
    env,
    signal ? AbortSignal.any([signal, lookup.signal]) : lookup.signal,
  );
  let sources: SourcesInput;
  try {
    const session = newSession(p, context, { llm, env, signal, watch, runsPerMonth: runs });
    const ideas = await askIdeas(session);
    if (ideas.problems.length > 0) {
      contextInput = { ...contextInput, problems: [...context.problems, ...ideas.problems] };
      context = ContextSchema.parse(contextInput);
      // Later suggestions from Claude take the new interests into account.
      session.context = context;
    }
    session.ideaQueries = ideas.queries;
    if (proposal) {
      // Offered in place of Claude's suggestions; with none proposed, Claude is still asked.
      const suggestions = cleanSuggestions(
        proposal.queries.map((q) => ({
          query: q.query,
          topic: q.topic,
          // The sites lead, so a query limited to them is told apart from the same words unlimited.
          hint: [q.includeDomains && `on ${q.includeDomains.join(", ")}`, q.evidence].filter(Boolean).join(" · ") || undefined,
          includeDomains: q.includeDomains,
          proposed: true,
        })),
      );
      if (suggestions.length > 0) session.suggestions = suggestions;
    }
    const proposed = await addProposedFeeds(session, {
      repos: proposal?.repos ?? [],
      sites: [...(proposal?.sites ?? []), ...ideas.sites],
    });
    sources = await askSources(session, proposed);
  } finally {
    lookup.abort();
  }
  context = ContextSchema.parse(contextInput);
  // Nothing touches the disk until every answer is in, so a cancel above leaves no trace.
  const { contextPath, sourcesPath } = await writeConfig(dir, { context: contextInput, sources }, { overwrite: true });
  // Written: going back would change nothing on disk.
  p.freeze?.();

  const paths = [contextPath, sourcesPath];
  const ignored = await checkIgnored(paths);
  paths.forEach((path, i) => {
    if (ignored[i] === false) {
      p.warn(`${path} is not ignored by git; add ${join(dir, "*.yml")} to .gitignore before committing.`);
    }
    if (ignored[i] === undefined) p.note(`Could not check whether git ignores ${path}.`);
  });
  const overrides = configEnvOverrides(env);
  for (const name of overrides) p.warn(`${name} is set and takes precedence over the files just written.`);

  const configDir = dir === DEFAULT_CONFIG_DIR ? "" : ` --config-dir ${shellQuote(dir)}`;
  const types = new Set(context.notify.channels.map((c) => c.type));
  // Slack can be posted to from this machine or from Actions; files stay on the machine that
  // runs pochi, so a setup without Slack is run locally.
  const onActions = types.has("slack") && (await askWhereToRun(p));
  let installed = false;
  if (!onActions && overrides.length > 0) {
    // schedule install validates and plans from what loadConfig reads, which would not be these files.
    p.warn(
      `The schedule was not installed: ${overrides.join(" and ")} would be used instead of the files just written. Unset ${overrides.length > 1 ? "them" : "it"}, then run \`node dist/pochi.mjs schedule install${configDir}\`.`,
    );
  } else if (!onActions && !runsFromBundle(deps.schedule)) {
    // The job would call the source through tsx, which a scheduled run cannot do.
    p.warn(
      `The schedule was not installed: init is running from source. Run \`npm run build\`, then \`node dist/pochi.mjs schedule install${configDir}\`.`,
    );
  } else if (!onActions) {
    installed = types.has("slack")
      ? await install(p, dir, deps.schedule)
      : await offerInstall(p, dir, context, timeZone, deps.schedule);
  }
  p.note(
    [
      `node dist/pochi.mjs run --dry-run${configDir}`,
      // Actions needs the secrets set first.
      ...(onActions
        ? [
            `gh secret set POCHI_CONTEXT_YAML < ${shellQuote(contextPath)}`,
            `gh secret set POCHI_SOURCES_YAML < ${shellQuote(sourcesPath)}`,
            `gh secret set SLACK_WEBHOOK_URL`,
            `gh secret set ANTHROPIC_API_KEY`,
            `node dist/pochi.mjs schedule install --backend github${configDir}`,
          ]
        : [
            `node dist/pochi.mjs run${configDir}`,
            installed
              ? `node dist/pochi.mjs schedule status${configDir}`
              : `node dist/pochi.mjs schedule install${configDir}`,
          ]),
    ].join("\n"),
    "Next steps",
  );
  p.outro(`Wrote ${contextPath} and ${sourcesPath}`);
}

const WEEK: readonly Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** The context.yml about to be overwritten, if it can be read. */
async function readPrevious(dir: string): Promise<Context | undefined> {
  const path = join(dir, "context.yml");
  try {
    return parseContext(await readFile(path, "utf8"), path);
  } catch {
    return undefined;
  }
}

type ScheduleInput = NonNullable<ContextInput["schedule"]>;

/**
 * Every day or on chosen weekdays, at a time; the time zone is the machine's (or the one set
 * before), so a run on Actions keeps the same wall time. A monthly or cron schedule set by hand
 * can be kept as it is.
 */
async function askSchedule(p: Prompter, previous: Schedule | undefined, timeZone: string): Promise<ScheduleInput> {
  const custom = previous?.interval === "monthly" || previous?.interval === "cron" ? previous : undefined;
  const interval = await p.select({
    message: "When should pochi run?",
    options: [
      { value: "daily" as const, label: "Every day" },
      { value: "weekly" as const, label: "On chosen days of the week" },
      ...(custom ? [{ value: "keep" as const, label: `Keep ${describeSchedule(custom, custom.timezone ?? timeZone)}` }] : []),
    ],
    initialValue: custom ? "keep" : previous?.interval === "weekly" ? "weekly" : "daily",
  });
  if (interval === "keep") return custom!;
  let days: Weekday[] = [];
  if (interval === "weekly") {
    const before = previous?.day === undefined ? ["monday" as const] : [previous.day].flat();
    for (;;) {
      days = await p.multiselect({
        message: "Days to run on (space to select)",
        options: WEEK.map((d) => ({ value: d, label: d[0]!.toUpperCase() + d.slice(1) })),
        initialValues: before,
      });
      if (days.length > 0) break;
      p.warn("Pick at least one day.");
    }
  }
  const time = await p.text({
    message: "Time to run (HH:MM, 24-hour)",
    placeholder: DEFAULT_TIME,
    initialValue: custom ? undefined : (previous?.time ?? DEFAULT_TIME),
    validate: validTime,
  });
  return {
    interval,
    ...(days.length > 0 && { day: days.length === 1 ? days[0] : days }),
    time: time.trim(),
    timezone: previous?.timezone ?? timeZone,
  };
}

function validTime(value: string): string | undefined {
  try {
    parseTime(value.trim());
    return undefined;
  } catch (err) {
    if (err instanceof CalendarError) return err.message;
    throw err;
  }
}

/** Whether a setup posting to Slack runs on GitHub Actions rather than on this machine. */
async function askWhereToRun(p: Prompter): Promise<boolean> {
  try {
    const where = await p.select({
      message: "Where should pochi run on schedule?",
      options: [
        { value: "local" as const, label: "This machine", hint: "launchd or cron; SLACK_WEBHOOK_URL from .env" },
        { value: "github" as const, label: "GitHub Actions", hint: "needs repository secrets" },
      ],
      initialValue: "local",
    });
    return where === "github";
  } catch (err) {
    // The config is already written, so a cancel here only skips the install; the next steps
    // still show how to run it on Actions.
    if (err instanceof PromptCancelled) return true;
    throw err;
  }
}

/**
 * Offers to install the job on this machine (launchd or cron) now that the config is written,
 * and whether it was installed.
 */
async function offerInstall(
  p: Prompter,
  dir: string,
  context: Context,
  timeZone: string,
  deps: ScheduleDeps | undefined,
): Promise<boolean> {
  let wanted: boolean;
  try {
    wanted = await p.confirm({
      message: `Install the schedule on this machine now (${describeSchedule(context.schedule, context.schedule.timezone ?? timeZone)})?`,
      initialValue: true,
    });
  } catch (err) {
    // The config is already written, so a cancel here only skips the install.
    if (err instanceof PromptCancelled) return false;
    throw err;
  }
  if (!wanted) return false;
  return install(p, dir, deps);
}

/**
 * Installs the job on this machine, and whether it was. A failure is a warning: the config is
 * fine, and the next steps still show the command.
 */
async function install(p: Prompter, dir: string, deps: ScheduleDeps | undefined): Promise<boolean> {
  const lines: string[] = [];
  try {
    await installSchedule({ configDir: dir }, { ...deps, write: (line) => void lines.push(line) });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    p.warn(`Could not install the schedule: ${err.message}`);
    return false;
  }
  p.note(lines.join("\n"), "Schedule");
  return true;
}

function noteProposal(p: Prompter, proposal: Proposal): void {
  const counts = [
    plural(proposal.problems.length, "problem"),
    plural(proposal.exclude.length, "exclusion"),
    plural(proposal.repos.length, "repository", "repositories"),
    plural(proposal.sites.length, "site"),
    plural(proposal.queries.length, "query", "queries"),
  ];
  p.note(`${counts.join(", ")}.\nEach is offered to pick, and checked before anything is written.`, "Proposal");
  if (proposal.dropped > 0) {
    p.warn(`Left out ${plural(proposal.dropped, "proposed entry", "proposed entries")}: malformed or past the limits.`);
  }
}

async function askContext(
  p: Prompter,
  proposal?: Proposal,
  previousChannels?: readonly ChannelConfig[],
): Promise<ContextInput> {
  const name = await p.text({
    message: "Project name",
    placeholder: "my-app",
    initialValue: proposal?.project.name || undefined,
    validate: required,
  });
  const description = await p.text({
    message: "Describe the project in a sentence or two (optional)",
    placeholder: "A Next.js SaaS app with a Postgres backend",
    initialValue: proposal?.project.description || undefined,
  });
  const problems = await askListWithProposals(p, proposal?.problems ?? [], {
    message: "What do you want to hear about?",
    placeholder: "Breaking changes in Next.js",
    min: 1,
    max: MAX_PROBLEMS,
  });
  const exclude = await askListWithProposals(p, proposal?.exclude ?? [], {
    message: "What should be dropped even if it looks related?",
    placeholder: "Funding news",
    min: 0,
    max: MAX_EXCLUDE,
  });
  const proposed = proposal?.language;
  const known = LANGUAGES.find((l) => l.toLowerCase() === proposed?.toLowerCase());
  const choice = await p.select({
    message: "Language for the summaries",
    options: [...LANGUAGES.map((l) => ({ value: l, label: l })), { value: "other", label: "Other" }],
    initialValue: known ?? (proposed ? "other" : "English"),
  });
  const language =
    choice === "other"
      ? (
          await p.text({
            message: "Language",
            placeholder: "German",
            initialValue: known ? undefined : proposed,
            validate: required,
          })
        ).trim()
      : choice;

  const channels = await askChannels(p, previousChannels);

  return {
    version: 1,
    project: { name: name.trim(), description: description.trim() },
    problems,
    ...(exclude.length > 0 && { exclude }),
    language,
    notify: { channels },
  };
}

const LANGUAGES = ["English", "Japanese"] as const;

type ChannelInput = NonNullable<NonNullable<ContextInput["notify"]>["channels"]>[number];

const CHANNELS = [
  { value: "slack", label: "Slack", hint: "an incoming webhook in SLACK_WEBHOOK_URL" },
  { value: "file", label: "Markdown files", hint: "reports/<date>.md" },
] as const;

/**
 * Asked again until one is picked: a run has to deliver somewhere. Starts from the channels set
 * before, or from files, which need no secret: Enter on another row keeps what is checked, so
 * a default that needs setting up would be picked by mistake.
 */
async function askChannels(p: Prompter, previous: readonly ChannelConfig[] = []): Promise<ChannelInput[]> {
  for (;;) {
    const picked = await p.multiselect({
      message: "Where should the briefing go? (space to toggle)",
      options: CHANNELS.map((c) => ({ ...c })),
      initialValues: previous.length > 0 ? previous.map((c) => c.type) : ["file"],
    });
    // A channel picked again keeps its settings, such as the reports dir.
    if (picked.length > 0) return picked.map((type) => previous.find((c) => c.type === type) ?? { type });
    p.warn("Pick at least one.");
  }
}

// The proposed entries come first, all picked, so accepting the proposal is one keypress;
// more can be typed after them, which is asked about so Enter does not seem to skip that.
async function askListWithProposals(
  p: Prompter,
  proposed: readonly ProposedText[],
  opts: { message: string; placeholder: string; min: number; max: number },
): Promise<string[]> {
  const seen = new Set<string>();
  const unique = proposed.filter((e) => once(seen, e.text.toLowerCase())).slice(0, opts.max);
  if (unique.length === 0) return askList(p, opts);
  const picked = await p.multiselect({
    message: `${opts.message} (proposed; space to toggle, enter to confirm)`,
    options: unique.map((e) => ({
      value: e.text,
      label: displayLine(e.text, SHOWN_MAX_CHARS),
      hint: displayLine(e.evidence, HINT_MAX_CHARS) || undefined,
    })),
    initialValues: unique.map((e) => e.text),
  });
  if (picked.length >= opts.max) return picked;
  const min = Math.max(0, opts.min - picked.length);
  if (min > 0) p.note(`Add at least ${min} of your own.`);
  else if (!(await askAddOwn(p, picked.length))) return picked;
  const typed = await askList(p, { ...opts, min, max: opts.max - picked.length, taken: picked });
  return [...picked, ...typed];
}

function askAddOwn(p: Prompter, picked: number): Promise<boolean> {
  return p.confirm({ message: `Add your own as well? (${picked} picked)`, initialValue: false });
}

// One text prompt per entry; an empty answer ends the list once min entries are in. An entry
// already in the list, or in taken, is refused whatever its case.
async function askList(
  p: Prompter,
  opts: { message: string; placeholder: string; min: number; max: number; taken?: readonly string[] },
): Promise<string[]> {
  const items: string[] = [];
  const seen = new Set((opts.taken ?? []).map((t) => t.toLowerCase()));
  while (items.length < opts.max) {
    const mandatory = items.length < opts.min;
    const answer = await p.text({
      message: `${opts.message} (${items.length + 1}/${opts.max}${mandatory ? "" : ", empty to finish"})`,
      placeholder: opts.placeholder,
      validate: (v) => {
        if (mandatory && required(v)) return required(v);
        return seen.has(v.trim().toLowerCase()) ? "Already in the list" : undefined;
      },
    });
    seen.add(answer.trim().toLowerCase());
    if (answer.trim() === "") break;
    items.push(answer.trim());
  }
  return items;
}

function lookUpLlm(
  resolve: typeof resolveLlm,
  context: Context,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): LlmLookup {
  return resolve(context.llm, { env, signal }).then(
    ({ client }) => ({ client }),
    (error: unknown) => ({ error }),
  );
}

/**
 * The LLM for suggestions, or undefined: init then takes repositories as owner/repo only. The
 * first call waits for the lookup started in the background.
 */
async function getLlm(s: SourceSession): Promise<LlmClient | undefined> {
  const lookup = s.llmLookup;
  if (lookup === undefined) return s.llm;
  s.llmLookup = undefined;
  const result = await s.p.spin("Looking for Claude", () => lookup, s.signal);
  throwIfCancelled(s.signal);
  if ("client" in result) {
    s.llm = result.client;
  } else {
    if (!(result.error instanceof LlmError)) throw result.error;
    s.p.warn(`${result.error.message}. Continuing without Claude: enter repositories as owner/repo.`);
  }
  return s.llm;
}

export interface SourceSession {
  p: Prompter;
  context: Context;
  /** Set by getLlm once the lookup settles; cleared when Claude turns out to be unusable (auth, unavailable). */
  llm: LlmClient | undefined;
  /** Still to be waited for; getLlm takes it. */
  llmLookup?: LlmLookup;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Watched: added and accepted in a trial fetch. */
  feeds: FeedInput[];
  queries: QueryInput[];
  /** Ids and dedupe keys of everything added, accepted or still to be tried. */
  ids: Set<string>;
  keys: Set<string>;
  /**
   * Feeds GitHub was asked about while adding them, with the latest item it returned, so the
   * trial fetch does not ask again. Keyed by object: a rejected source's id may be reused.
   */
  checked: WeakMap<FeedInput, Item | undefined>;
  /** Asked once (or taken from a proposal); later rounds offer what is left of them. */
  suggestions?: QuerySuggestion[];
  /** From the ideas picked; offered with the suggestions, which Claude is still asked for. */
  ideaQueries?: QuerySuggestion[];
  /** Who the user named on the command line; empty lists when nobody was. */
  watch: Watchlist;
  /** Runs in the next 30 days at the schedule asked, for what web searches cost. */
  runsPerMonth?: number;
  tavilyNoted?: boolean;
}

export function newSession(
  p: Prompter,
  context: Context,
  opts: {
    llm?: LlmClient | LlmLookup;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    watch?: Watchlist;
    runsPerMonth?: number;
  } = {},
): SourceSession {
  const { llm, signal } = opts;
  return {
    p,
    context,
    ...(llm instanceof Promise ? { llm: undefined, llmLookup: llm } : { llm }),
    env: opts.env ?? process.env,
    signal,
    feeds: [],
    queries: [],
    ids: new Set(),
    keys: new Set(),
    checked: new WeakMap(),
    watch: opts.watch ?? EMPTY_WATCHLIST,
    ...(opts.runsPerMonth !== undefined && { runsPerMonth: opts.runsPerMonth }),
  };
}

/**
 * Each competitor and business named on the command line, searched for by its name as typed (in
 * the user's language) and, with --news-site, only on those sites. Offered, never picked for the user.
 */
function watchQueries(watch: Watchlist): QuerySuggestion[] {
  const on = watch.newsSites.length > 0 ? ` on ${watch.newsSites.join(", ")}` : "";
  const named = (names: string[], kind: string) =>
    names.map((query) => ({
      query,
      topic: "news" as const,
      hint: `${kind}${on}`,
      ...(watch.newsSites.length > 0 && { includeDomains: watch.newsSites }),
    }));
  return [...named(watch.competitors, "competitor"), ...named(watch.adopters, "adopter")];
}

type Ideas = { problems: string[]; sites: { url: string; evidence: string }[]; queries: QuerySuggestion[] };

/**
 * Asks Claude for interests the answers so far may miss (tech, design, marketing, industry and more), each
 * with sites and queries that would bring news on it. The sites and queries of the ideas picked
 * are offered with the rest of the sources, and checked the same way.
 */
async function askIdeas(s: SourceSession): Promise<Ideas> {
  const { p, signal } = s;
  const none: Ideas = { problems: [], sites: [], queries: [] };
  const room = MAX_PROBLEMS - s.context.problems.length;
  if (room <= 0) return none;
  // So nobody picks a dozen ideas only to have most of them cut.
  p.note(`${s.context.problems.length} of ${MAX_PROBLEMS} interests so far.`, "Interests");
  const wanted = await p.confirm({
    message: "Ask Claude for ideas from technology, design, marketing and industry angles you may have missed?",
    initialValue: true,
  });
  if (!wanted) return none;
  const llm = await getLlm(s);
  if (!llm) return none;
  let reply: IdeaSuggestionOutput;
  try {
    reply = await p.spin(
      "Asking Claude for ideas",
      () => llm.generate(ideaSuggestionRequest(s.context, s.watch), { signal }),
      signal,
    );
  } catch (err) {
    throwIfCancelled(signal);
    if (!(err instanceof LlmError)) throw err;
    llmFailed(s, err);
    return none;
  }

  const seen = new Set(s.context.problems.map((t) => t.toLowerCase()));
  const ideas = reply.ideas
    .map((idea) => ({ ...idea, problem: cleanQuery(idea.problem) }))
    .filter((idea) => idea.problem !== "" && once(seen, idea.problem.toLowerCase()))
    .slice(0, MAX_IDEAS);
  if (ideas.length === 0) {
    p.note("Claude had nothing to add.");
    return none;
  }
  // None picked to begin with: each brings more news on every run.
  const picked = await p.multiselect({
    message: "Ideas to add to what you want to hear about (space to select, enter to confirm)",
    options: ideas.map((idea) => ({
      value: idea.problem,
      label: `[${idea.perspective}] ${displayLine(idea.problem, SHOWN_MAX_CHARS)}`,
      hint: displayLine(idea.why, HINT_MAX_CHARS) || undefined,
    })),
  });
  if (picked.length > room) p.warn(`Only ${plural(room, "more interest")} fit; kept the first ${room}.`);
  const chosen = ideas.filter((idea) => picked.includes(idea.problem)).slice(0, room);
  return {
    problems: chosen.map((idea) => idea.problem),
    sites: chosen.flatMap((idea) =>
      idea.sites
        .slice(0, MAX_IDEA_SITES)
        .map((url) => parseHttpUrl(url.trim())?.href)
        .filter((url) => url !== undefined)
        .map((url) => ({ url, evidence: `idea: ${idea.perspective}` })),
    ),
    queries: chosen.flatMap((idea) =>
      idea.queries
        .slice(0, MAX_IDEA_QUERIES)
        .map((query) => ({ query, topic: "news" as const, hint: `idea: ${idea.perspective}`, proposed: true })),
    ),
  };
}

/**
 * Asks for feeds and queries, fetches the latest item of each and keeps them, asking about the
 * ones that failed or have nothing yet. Repeats until at least one is kept, since sources.yml needs one.
 */
export async function askSources(s: SourceSession, proposed: FeedInput[] = []): Promise<SourcesInput> {
  // Proposed feeds were claimed already; the first trial fetch tries them with the typed ones.
  let pending = proposed;
  for (;;) {
    const feeds = await askFeeds(s, pending);
    pending = [];
    feeds.push(...(await askNewsSearches(s)));
    const queries = await askWebSearches(s);
    if (feeds.length + queries.length > 0) {
      const kept = await trialFetch(s, feeds, queries);
      s.feeds.push(...kept.feeds);
      s.queries.push(...kept.queries);
    }
    if (s.feeds.length + s.queries.length > 0) break;
    s.p.warn("Nothing to watch yet; add a source.");
  }
  return { version: 1, feeds: s.feeds, ...(s.queries.length > 0 && { queries: s.queries }) };
}

async function askFeeds(s: SourceSession, added: FeedInput[] = []): Promise<FeedInput[]> {
  for (;;) {
    const count = s.feeds.length + added.length;
    const kind = await s.p.select({
      message: count === 0 ? "Add a source to watch" : `Add another source? (${count} so far)`,
      options: [
        {
          value: "repo",
          label: "Technology or GitHub repository",
          // Claude may still be looked for; the step itself says if it is not there.
          hint: s.llm || s.llmLookup ? "Next.js or vercel/next.js" : "owner/repo",
        },
        { value: "site", label: "Blog or feed URL", hint: "https://…" },
        { value: "news", label: "News search (Google News, free)", hint: "words, optionally on chosen sites" },
        // sources.yml needs a source; searches, if any are offered, are asked next.
        ...(count > 0 || tavilyApiKey(s.env) || mayOfferNews(s) ? [{ value: "done" as const, label: "Done" }] : []),
      ],
    });
    if (kind === "done") return added;

    const feed = kind === "repo" ? await askRepo(s) : kind === "site" ? await askSite(s) : await askNews(s);
    // Nothing found, or backed out: back to the choice above.
    if (!feed) continue;
    if (!claim(s, keyOf(feed), feed.id)) {
      s.p.warn("Already added; skipped.");
      continue;
    }
    added.push(feed);
  }
}

async function askRepo(s: SourceSession): Promise<FeedInput | undefined> {
  const llm = await getLlm(s);
  const answer = (
    await s.p.text({
      message: llm ? "Technology name or GitHub repository (empty to go back)" : "GitHub repository (empty to go back)",
      placeholder: llm ? "Next.js" : "vercel/next.js",
      validate: (v) => {
        const t = v.trim();
        if (t === "" || REPO_PATTERN.test(t)) return undefined;
        // Without Claude there is nothing to look a name up with; a slash means a repo was meant.
        return llm && !t.includes("/") ? undefined : "Enter it as owner/repo";
      },
    })
  ).trim();
  if (answer === "") return undefined;
  // Typed as owner/repo: used as is, never through the model.
  if (REPO_PATTERN.test(answer)) {
    // Checked before GitHub is asked, which allows few unauthenticated calls an hour.
    if (s.keys.has(repoKey(answer))) {
      s.p.warn("Already added; skipped.");
      return undefined;
    }
    return checkTypedRepo(s, answer);
  }
  return lookUpRepo(s, llm!, answer);
}

async function checkTypedRepo(s: SourceSession, repo: string): Promise<FeedInput | undefined> {
  const { p, signal } = s;
  let check: RepoCheck;
  try {
    check = await p.spin(`Checking ${repo} on GitHub`, () => verifyRepo(repo, signal), signal);
  } catch (err) {
    throwIfCancelled(signal);
    if (!(err instanceof HttpError || err instanceof FeedParseError)) throw err;
    // It may exist: the user typed it, so let them decide.
    p.warn(`Could not check ${repo} on GitHub: ${errorLine(err)}`);
    if (!(await p.confirm({ message: `Add ${repo} anyway?`, initialValue: false }))) return undefined;
    return repoFeed(s, repo);
  }
  return checkedRepoFeed(s, repo, check, "");
}

/** The feed for a repository GitHub answered about, or undefined (with a warning) when there is none to watch. */
function checkedRepoFeed(s: SourceSession, repo: string, check: RepoCheck, suffix: string): FeedInput | undefined {
  const { p } = s;
  if (check.status === "not_found") {
    p.warn(`${repo} was not found on GitHub${suffix}.`);
    return undefined;
  }
  const current = check.movedTo ?? repo;
  if (check.movedTo) p.note(`${repo} moved to ${current}; watching that instead.`);
  if (check.status === "empty") {
    p.warn(`${current} has no releases or tags to watch${suffix}.`);
    return undefined;
  }
  return repoFeed(s, current, check);
}

// Only repositories GitHub confirms are offered: a model can name ones that do not exist.
async function lookUpRepo(s: SourceSession, llm: LlmClient, name: string): Promise<FeedInput | undefined> {
  const { p, signal } = s;
  let candidates: { repo: string; note: string }[];
  try {
    const reply = await p.spin(
      `Asking Claude where ${name} is developed`,
      () => llm.generate(repoInferenceRequest(s.context, [name]), { signal }),
      signal,
    );
    candidates = reply.results.find((r) => r.id === queryId(0))?.candidates ?? [];
  } catch (err) {
    throwIfCancelled(signal);
    if (!(err instanceof LlmError)) throw err;
    llmFailed(s, err);
    p.warn(`Could not look up ${name}; enter it as owner/repo.`);
    return undefined;
  }

  const seen = new Set<string>();
  const named = candidates
    .map((c) => ({ repo: c.repo.trim(), note: c.note }))
    .filter((c) => REPO_PATTERN.test(c.repo) && once(seen, c.repo.toLowerCase()));
  // Ones already added are not checked again.
  const valid = named.filter((c) => !s.keys.has(repoKey(c.repo))).slice(0, MAX_REPO_CANDIDATES);
  if (named.length > 0 && valid.length === 0) {
    p.warn("Already added; skipped.");
    return undefined;
  }
  const checks =
    valid.length === 0
      ? []
      : await p.spin(
          `Checking ${plural(valid.length, "candidate")} on GitHub`,
          () => Promise.allSettled(valid.map((c) => verifyRepo(c.repo, signal))),
          signal,
        );
  throwIfCancelled(signal);

  const found: { repo: string; note: string; check: FoundRepo }[] = [];
  const current = new Set<string>();
  checks.forEach((result, i) => {
    if (result.status !== "fulfilled" || result.value.status !== "found") return;
    // Two candidates can be one repository under its old and new name.
    const repo = result.value.movedTo ?? valid[i]!.repo;
    if (once(current, repo.toLowerCase())) found.push({ repo, note: valid[i]!.note, check: result.value });
  });
  const unchecked = checks.filter((r) => r.status === "rejected").length;
  if (found.length === 0) {
    // A rate limit or a network failure says nothing about whether the repository exists.
    p.warn(
      unchecked > 0
        ? `Could not check ${plural(unchecked, "candidate")} for ${name} on GitHub; try again later or enter it as owner/repo.`
        : `No GitHub repository found for ${name}; enter it as owner/repo.`,
    );
    return undefined;
  }
  if (unchecked > 0) p.warn(`Could not check ${plural(unchecked, "candidate")} on GitHub; left out.`);

  const choice = await p.select({
    message: `Which repository is ${name}?`,
    options: [
      ...found.map((f) => ({ value: f.repo, label: f.repo, hint: displayLine(f.note, HINT_MAX_CHARS) || undefined })),
      { value: NONE, label: "None of these" },
    ],
  });
  const chosen = found.find((f) => f.repo === choice);
  return chosen && repoFeed(s, chosen.repo, chosen.check);
}

function repoFeed(s: SourceSession, repo: string, check?: FoundRepo): FeedInput {
  // Otherwise nothing would arrive until the first stable release.
  if (check?.onlyPrereleases) s.p.note(`${repo} has only prereleases so far; following them.`);
  const feed: FeedInput = {
    id: sourceIdFrom(repo.split("/")[1]!, s.ids),
    type: "github",
    name: repo,
    repo,
    ...(check?.feed === "tags" && { feed: "tags" as const }),
    ...(check?.onlyPrereleases && { includePrereleases: true }),
  };
  if (check) s.checked.set(feed, check.latest);
  return feed;
}

async function askSite(s: SourceSession): Promise<FeedInput | undefined> {
  const raw = (
    await s.p.text({
      message: "Blog or feed URL (empty to go back)",
      placeholder: "https://simonwillison.net/",
      validate: (v) => (v.trim() === "" || parseHttpUrl(v.trim()) ? undefined : "Enter an absolute http(s) URL"),
    })
  ).trim();
  if (raw === "") return undefined;
  return resolveSite(s, parseHttpUrl(raw)!.href);
}

/** Finds the feed of a page, asking which one when it has several. */
async function resolveSite(s: SourceSession, url: string): Promise<FeedInput | undefined> {
  const { p, signal } = s;
  // Given as the feed itself; one found on a page is checked when it is added.
  if (s.keys.has(feedKey(url))) {
    p.warn("Already added; skipped.");
    return undefined;
  }
  const found = await settle(p.spin(`Looking for feeds on ${url}`, () => discoverFeeds(url, signal), signal));
  throwIfCancelled(signal);
  return pickSiteFeed(s, url, found, true);
}

/**
 * Turns what discoverFeeds settled with into a feed, asking which one when the page has several.
 * A feed that could not be checked is offered anyway only when the user typed the URL: a
 * proposed one is left out, since nobody vouches for it.
 */
async function pickSiteFeed(
  s: SourceSession,
  url: string,
  found: PromiseSettledResult<DiscoveredFeed[]>,
  typed: boolean,
): Promise<FeedInput | undefined> {
  const { p } = s;
  const leftOut = typed ? "" : "; left out";
  if (found.status === "rejected") {
    const err: unknown = found.reason;
    // The page opened; a feed it led to did not.
    if (err instanceof FeedCheckError) {
      p.warn(`Could not check a feed on ${url}: ${errorLine(err)}${leftOut}`);
      // An advertised feed may be up again by the next run; a guessed path may be no feed at all.
      const shown = displayLine(err.feedUrl, SHOWN_MAX_CHARS);
      if (!typed || !err.advertised || !(await p.confirm({ message: `Add ${shown} anyway?`, initialValue: false }))) {
        return undefined;
      }
      return siteFeed(s, url, err.feedUrl);
    }
    if (!(err instanceof HttpError)) throw err;
    p.warn(`Could not open ${url}: ${errorLine(err)}${leftOut}`);
    // It may be up again by the next run; the user typed it, so let them decide.
    if (!typed || !isTransient(err) || !(await p.confirm({ message: `Add ${url} as a feed anyway?`, initialValue: false }))) {
      return undefined;
    }
    return siteFeed(s, url, url);
  }
  const feeds = found.value;
  if (feeds.length === 0) {
    p.warn(`No feed found on ${url}${leftOut}.`);
    return undefined;
  }
  if (feeds.length === 1) return siteFeed(s, url, feeds[0]!.url);
  const choice = await p.select({
    message: `${url} has ${feeds.length} feeds; which one?`,
    options: [
      // The titles come from the page.
      ...feeds.map((f) => ({
        value: f.url,
        label: (f.title && displayLine(f.title, SHOWN_MAX_CHARS)) || f.url,
        ...(f.title && { hint: f.url }),
      })),
      { value: NONE, label: "None of these" },
    ],
  });
  const chosen = feeds.find((f) => f.url === choice);
  return chosen && siteFeed(s, url, chosen.url, chosen.title);
}

// Named after the URL the user gave, not the feed's host (feeds.feedburner.com), with its path
// so feeds on one host differ, and with the title the page gave the feed chosen among several.
function siteFeed(s: SourceSession, pageUrl: string, feedUrl: string, title?: string): FeedInput {
  const page = new URL(pageUrl);
  const host = page.hostname.replace(/^www\./, "");
  const base = `${host}${page.pathname.replace(/\/+$/, "")}`;
  const shown = title && displayLine(title, HINT_MAX_CHARS);
  return { id: sourceIdFrom(host, s.ids), type: "rss", name: shown ? `${base}: ${shown}` : base, url: feedUrl };
}

/**
 * Offers the proposed repositories and sites, all picked, and keeps those GitHub confirms or that
 * have a feed. Unlike a name typed in, a proposed repository GitHub cannot check is left out:
 * nobody typed it, so nobody vouches for it.
 */
async function addProposedFeeds(s: SourceSession, proposal: Pick<Proposal, "repos" | "sites">): Promise<FeedInput[]> {
  const { p, signal } = s;
  const added: FeedInput[] = [];
  const keep = (feed: FeedInput | undefined) => {
    if (!feed) return;
    if (claim(s, keyOf(feed), feed.id)) added.push(feed);
    else p.warn(`Already added: ${displayLine(labelOf(feed), SHOWN_MAX_CHARS)}; skipped.`);
  };

  const seenRepos = new Set<string>();
  const repos = proposal.repos.filter((r) => once(seenRepos, r.repo.toLowerCase()));
  const chosenRepos =
    repos.length === 0
      ? []
      : await p.multiselect({
          message: "Proposed repositories to watch (space to toggle)",
          options: repos.map((r) => ({ value: r.repo, label: r.repo, hint: displayLine(r.evidence, HINT_MAX_CHARS) || undefined })),
          initialValues: repos.map((r) => r.repo),
        });
  if (chosenRepos.length > 0) {
    const limit = pLimit(GITHUB_CONCURRENCY);
    const checks = await p.spin(
      `Checking ${plural(chosenRepos.length, "repository", "repositories")} on GitHub`,
      () => Promise.allSettled(chosenRepos.map((repo) => limit(() => verifyRepo(repo, signal)))),
      signal,
    );
    throwIfCancelled(signal);
    // In the order proposed, one at a time: each id is chosen against the ones claimed before it.
    chosenRepos.forEach((repo, i) => {
      const result = checks[i]!;
      if (result.status === "rejected") {
        const err: unknown = result.reason;
        if (!(err instanceof HttpError || err instanceof FeedParseError)) throw err;
        p.warn(`Could not check ${repo} on GitHub: ${errorLine(err)}; left out.`);
        return;
      }
      keep(checkedRepoFeed(s, repo, result.value, "; left out"));
    });
  }

  const seenSites = new Set<string>();
  const sites = proposal.sites.filter((site) => once(seenSites, normalizeUrl(site.url) ?? site.url));
  const chosenSites =
    sites.length === 0
      ? []
      : await p.multiselect({
          message: "Proposed sites to watch (space to toggle)",
          options: sites.map((site) => ({
            value: site.url,
            label: displayLine(site.url, SHOWN_MAX_CHARS),
            hint: displayLine(site.evidence, HINT_MAX_CHARS) || undefined,
          })),
          initialValues: sites.map((site) => site.url),
        });
  if (chosenSites.length > 0) {
    const limit = pLimit(SITE_CONCURRENCY);
    const found = await p.spin(
      `Looking for feeds on ${plural(chosenSites.length, "site")}`,
      () => Promise.allSettled(chosenSites.map((url) => limit(() => discoverFeeds(url, signal)))),
      signal,
    );
    throwIfCancelled(signal);
    // In the order proposed, one at a time: a page with several feeds asks which one.
    for (const [i, url] of chosenSites.entries()) keep(await pickSiteFeed(s, url, found[i]!, false));
  }
  return added;
}

// Google News editions by the summary language; the rest search the English one.
const LOCALES: Record<string, string> = { English: "en-US", Japanese: "ja-JP" };

function localeOf(context: Context): string {
  return LOCALES[context.language] ?? "en-US";
}

/** Runs in the next 30 days, capped: a cron job every minute is not worth counting. */
export function runsPerMonth(schedule: Schedule, timeZone: string, now: Date): number {
  const end = now.getTime() + 30 * 86_400_000;
  return nextRuns(calendarOf(schedule), schedule.timezone ?? timeZone, now, 1000).filter((r) => r.getTime() < end).length;
}

function newsFeed(s: SourceSession, query: string, sites: string[] | undefined): FeedInput | undefined {
  const id = queryIdFrom(query, s.ids);
  return { id, type: "googlenews", query, ...(sites && sites.length > 0 && { sites }), locale: localeOf(s.context) };
}

/** Typed from the sources menu: the words, then the sites to keep to. */
async function askNews(s: SourceSession): Promise<FeedInput | undefined> {
  const query = cleanQuery(
    await s.p.text({ message: "Google News search (empty to go back)", placeholder: "Qwen model release" }),
  );
  if (query === "") return undefined;
  const typed = await s.p.text({
    message: "Only on these sites (domain names, comma-separated; empty for any)",
    placeholder: "prtimes.jp",
    validate: (v) => (parseSites(v) === undefined ? "Enter domain names such as prtimes.jp, separated by commas" : undefined),
  });
  return newsFeed(s, query, parseSites(typed));
}

function parseSites(value: string): string[] | undefined {
  const parts = value.split(/[,、\s]+/).filter((v) => v !== "");
  const sites = parts.map((v) => DomainSchema.safeParse(v).data);
  return sites.every((d) => d !== undefined) ? [...new Set(sites)] : undefined;
}

// Searches will be offered after the menu: some are known, or Claude may still suggest some.
function mayOfferNews(s: SourceSession): boolean {
  return offeredNews(s).length > 0 || (s.suggestions === undefined && (s.llm !== undefined || s.llmLookup !== undefined));
}

/** News searches offered without asking Claude: named on the command line, proposed, from ideas. */
function offeredNews(s: SourceSession): QuerySuggestion[] {
  const news = (s.suggestions ?? []).filter((q) => q.topic === "news");
  return cleanSuggestions([...watchQueries(s.watch), ...news, ...(s.ideaQueries ?? [])]).filter(
    (q) => !s.keys.has(newsKey(q.query, q.includeDomains)),
  );
}

/**
 * Offers searches as Google News feeds: free and keyless, so asked whether or not Tavily is set
 * up. Claude is asked for suggestions once when nothing was proposed. Proposed ones (from the
 * proposal or the ideas picked) are picked to begin with.
 */
async function askNewsSearches(s: SourceSession): Promise<FeedInput[]> {
  const { p, signal } = s;
  if (s.suggestions === undefined) {
    const llm = await getLlm(s);
    s.suggestions = [];
    if (llm) {
      try {
        const reply = await p.spin(
          "Asking Claude for search queries",
          () => llm.generate(querySuggestionRequest(s.context, s.watch), { signal }),
          signal,
        );
        s.suggestions = cleanSuggestions(reply.queries.map((query) => ({ query, topic: "news" as const }))).slice(
          0,
          MAX_QUERY_SUGGESTIONS,
        );
      } catch (err) {
        throwIfCancelled(signal);
        if (!(err instanceof LlmError)) throw err;
        llmFailed(s, err);
      }
    }
  }
  const offered = offeredNews(s);
  if (offered.length === 0) return [];
  const picked = await p.multiselect({
    message: "News searches to run (Google News, free; space to select)",
    options: offered.map((q) => ({
      value: q.query,
      label: displayLine(q.query, SHOWN_MAX_CHARS),
      hint: q.hint && (displayLine(q.hint, HINT_MAX_CHARS) || undefined),
    })),
    initialValues: offered.filter((q) => q.proposed).map((q) => q.query),
  });
  const added: FeedInput[] = [];
  for (const q of offered.filter((o) => picked.includes(o.query))) {
    const feed = newsFeed(s, q.query, q.includeDomains);
    if (feed && claim(s, keyOf(feed), feed.id)) added.push(feed);
  }
  return added;
}

/**
 * Offers web searches, which run on Tavily: only with a key, and with what they cost said first,
 * since each one is a paid search on every run. The proposal's general queries are the
 * candidates (news ones went to Google News); none is picked for the user.
 */
async function askWebSearches(s: SourceSession): Promise<QueryInput[]> {
  const { p } = s;
  const candidates = cleanSuggestions((s.suggestions ?? []).filter((q) => q.topic === "general")).filter(
    (q) => !s.keys.has(queryKey(q.query)),
  );
  // A run reads the same key (from process.env, which env is outside tests), so a query asked
  // for here is one a run can fetch.
  if (!tavilyApiKey(s.env)) {
    if (!s.tavilyNoted && candidates.length > 0) {
      p.note(
        `TAVILY_API_KEY is not set, so web searches are skipped (${plural(candidates.length, "proposed web search", "proposed web searches")} left out).`,
      );
    }
    s.tavilyNoted = true;
    return [];
  }
  const runs = s.runsPerMonth;
  const each = runs === undefined ? "" : ` (about ${plural(runs, "credit")} a month each at this schedule)`;
  if (!s.tavilyNoted) {
    p.note(
      `Web searches run on Tavily, a paid search API: each one costs a credit on every run${each}, and one now to try it. The free plan has ${TAVILY_FREE_CREDITS} credits a month, so add only what a news search cannot find.`,
      "Tavily",
    );
  }
  s.tavilyNoted = true;

  const chosen: QuerySuggestion[] = [];
  let addOwn = true;
  if (candidates.length > 0) {
    const picked = await p.multiselect({
      message: "Web searches to run (Tavily, paid; space to select)",
      options: candidates.map((q) => ({
        value: q.query,
        label: displayLine(q.query, SHOWN_MAX_CHARS),
        hint: q.hint && (displayLine(q.hint, HINT_MAX_CHARS) || undefined),
      })),
    });
    chosen.push(...candidates.filter((q) => picked.includes(q.query)));
    addOwn = await askAddOwn(p, picked.length);
  }
  const typed = addOwn
    ? await askList(p, { message: "Add a web search (Tavily)", placeholder: "Qwen Image LoRA", min: 0, max: MAX_TYPED_QUERIES })
    : [];
  // Control characters alone clean to nothing.
  chosen.push(...typed.map(cleanQuery).filter((q) => q !== "").map((query) => ({ query, topic: "general" as const })));

  const added: QueryInput[] = [];
  for (const { query, topic, includeDomains } of chosen) {
    const id = queryIdFrom(query, s.ids);
    if (!claim(s, queryKey(query), id)) {
      p.warn(`Already added: ${displayLine(query, SHOWN_MAX_CHARS)}; skipped.`);
      continue;
    }
    added.push({ id, query, topic, ...(includeDomains && { includeDomains }) });
  }
  const total = s.queries.length + added.length;
  if (added.length > 0 && runs !== undefined) {
    const credits = total * runs;
    const line = `${plural(total, "web search", "web searches")}: about ${plural(credits, "Tavily credit")} a month.`;
    if (credits > TAVILY_FREE_CREDITS) p.warn(`${line} That is more than the ${TAVILY_FREE_CREDITS} the free plan has.`);
    else p.note(line, "Tavily");
  }
  return added;
}

/** Shows the latest item of each source; asks whether to keep the ones that failed or have nothing yet. */
async function trialFetch(
  s: SourceSession,
  feeds: FeedInput[],
  queries: QueryInput[],
): Promise<{ feeds: FeedInput[]; queries: QueryInput[] }> {
  const { p, signal } = s;
  const sources = SourcesSchema.parse({ version: 1, feeds, queries });
  // Queries only get here with a Tavily key.
  const configs = sourceConfigs(sources, true);
  // GitHub already showed the latest item of the checked feeds. Found by id, which is unique
  // in a session: parsing made new objects.
  const byId = new Map(feeds.map((f) => [f.id, f]));
  const checkedFeed = (source: SourceConfig) => {
    const feed = source.kind === "tavily" ? undefined : byId.get(source.feed.id);
    return feed && s.checked.has(feed) ? feed : undefined;
  };
  const toFetch = configs.filter((source) => !checkedFeed(source));
  const fetched =
    toFetch.length === 0
      ? []
      : await p.spin(
          `Fetching the latest from ${plural(toFetch.length, "source")}`,
          () => fetchEach(toFetch, sources.defaults, { signal }),
          signal,
        );
  if (signal?.aborted || fetched.some((o) => "aborted" in o)) throw new PromptCancelled();
  // Each outcome carries the config it was fetched for.
  const byConfig = new Map(fetched.map((o) => [o.source, o]));
  const outcomes = configs.map((source): SourceOutcome => {
    const feed = checkedFeed(source);
    if (!feed) return byConfig.get(source)!;
    const latest = s.checked.get(feed);
    return { source, items: latest ? [latest] : [] };
  });

  const rejected = new Set<string>();
  for (const outcome of outcomes) {
    const { id, name, kind } = sourceInfo(outcome.source);
    const label = displayLine(name, SHOWN_MAX_CHARS);
    let ok = true;
    if ("error" in outcome) {
      ok = false;
      p.warn(`${label} (${kind}) failed: ${errorLine(outcome.error)}`);
    } else if ("items" in outcome) {
      const item = outcome.items[0];
      p.note(
        item
          ? [
              displayLine(item.title, SHOWN_MAX_CHARS),
              ...(item.publishedAt ? [item.publishedAt.slice(0, 10)] : []),
              displayLine(item.url, SHOWN_MAX_CHARS),
            ].join("\n")
          : "No items yet.",
        `${label} (${kind})`,
      );
      // The user just picked it, so only one that brought nothing is asked about again.
      if (item) continue;
    }
    if (!(await p.confirm({ message: `Watch ${label} anyway?`, initialValue: ok }))) rejected.add(id);
  }

  // A rejected source may be added again later, perhaps another way.
  for (const source of [...feeds, ...queries]) {
    if (!rejected.has(source.id)) continue;
    s.ids.delete(source.id);
    s.keys.delete(keyOf(source));
  }
  return { feeds: feeds.filter((f) => !rejected.has(f.id)), queries: queries.filter((q) => !rejected.has(q.id)) };
}

// GitHub treats owner/repo case-insensitively; feed URLs compare as the pipeline dedupes them. A
// news search and a web search for the same words are different sources.
function keyOf(source: FeedInput | QueryInput): string {
  if (!("type" in source)) return queryKey(source.query);
  switch (source.type) {
    case "github":
      return repoKey(source.repo);
    case "googlenews":
      return newsKey(source.query, source.sites);
    case "rss":
      return feedKey(source.url);
  }
}

function newsKey(query: string, sites: readonly string[] = []): string {
  return `news:${cleanQuery(query).toLowerCase()}|${[...sites].sort().join(",")}`;
}

/** What a source is called on screen; a news search may have no name of its own. */
function labelOf(feed: FeedInput): string {
  return feed.type === "googlenews" ? (feed.name ?? feed.query) : feed.name;
}

function repoKey(repo: string): string {
  return `github:${repo.toLowerCase()}`;
}

function feedKey(url: string): string {
  return `rss:${normalizeUrl(url)}`;
}

function queryKey(query: string): string {
  return `query:${cleanQuery(query).toLowerCase()}`;
}

// What is stored and searched for; shortening for the screen is left to displayLine.
function cleanQuery(query: string): string {
  return collapseWhitespace(stripControlChars(query));
}

/** Cleans each query, dropping the ones that clean to nothing and repeats in any case. */
function cleanSuggestions(suggestions: QuerySuggestion[]): QuerySuggestion[] {
  const seen = new Set<string>();
  return suggestions
    .map((q) => ({ ...q, query: cleanQuery(q.query) }))
    .filter((q) => q.query !== "" && once(seen, q.query.toLowerCase()));
}

/** Records the source as added; false when it already was. */
function claim(s: SourceSession, key: string, id: string): boolean {
  if (s.keys.has(key)) return false;
  s.keys.add(key);
  s.ids.add(id);
  return true;
}

function once(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

// Auth and unavailable will not pass on the next call; anything else may.
function llmFailed(s: SourceSession, err: LlmError): void {
  if (err.kind === "auth" || err.kind === "unavailable") {
    s.llm = undefined;
    s.p.warn(`Claude is not usable (${err.kind}); continuing without it.`);
  } else {
    s.p.warn(`Claude could not answer (${err.kind}).`);
  }
}

// Like Promise.allSettled for one promise.
function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

// A fetch cut short by Ctrl-C fails like any other; the signal tells them apart.
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PromptCancelled();
}

function errorLine(err: unknown): string {
  return displayLine(err instanceof Error ? err.message : String(err), SHOWN_MAX_CHARS);
}

/** Turns a repo or host name into a source id that is not in taken. */
export function sourceIdFrom(raw: string, taken: ReadonlySet<string>): string {
  return uniqueId(slug(raw) || "source", taken);
}

/**
 * A source id for a query that is not in taken: an ASCII query's words, cut short, or else a
 * hash of the query, which (unlike a counter) does not change when queries are reordered.
 */
export function queryIdFrom(query: string, taken: ReadonlySet<string>): string {
  const words = /^[\x20-\x7e]*$/.test(query) ? cutAtWord(slug(query), QUERY_ID_MAX_CHARS) : "";
  return uniqueId(words || `query-${sha256Hex(query.toLowerCase()).slice(0, 8)}`, taken);
}

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
}

function cutAtWord(id: string, max: number): string {
  if (id.length <= max) return id;
  const cut = id.slice(0, max + 1);
  const at = cut.lastIndexOf("-");
  return (at > 0 ? cut.slice(0, at) : cut.slice(0, max)).replace(/[-_]+$/, "");
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function required(value: string): string | undefined {
  return value.trim() === "" ? "Required" : undefined;
}

/** Quotes a value for a POSIX shell, leaving plain paths as they are. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

// One git call for paths that share a directory. It runs in that directory so a --config-dir
// inside another repository is checked against that one.
export async function gitCheckIgnored(paths: string[]): Promise<(boolean | undefined)[]> {
  const names = paths.map((path) => basename(path));
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("git", ["check-ignore", "--", ...names], {
      cwd: dirname(resolve(paths[0]!)),
    }));
  } catch (err) {
    // 1 means none is ignored; anything else (128 outside a repository, ENOENT without git) means unknown.
    const { code, stdout: out } = err as { code?: unknown; stdout?: unknown };
    if (code !== 1) return paths.map(() => undefined);
    stdout = typeof out === "string" ? out : "";
  }
  // Prints the ignored ones among the names it was given, one per line as given
  // (the names are context.yml and sources.yml, so git has nothing to quote).
  const ignored = new Set(stdout.split("\n"));
  return names.map((name) => ignored.has(name));
}
