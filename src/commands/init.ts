import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigError, DEFAULT_CONFIG_DIR } from "../config/load.js";
import {
  type Context,
  type ContextInput,
  ContextSchema,
  REPO_PATTERN,
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
import { DISCOVERY_PROMPT } from "../proposal/prompt.js";
import { type DiscoveredFeed, FeedCheckError, discoverFeeds, isTransient } from "../sources/discover.js";
import { type RepoCheck, verifyRepo } from "../sources/github.js";
import { type SourceConfig, type SourceOutcome, fetchEach, sourceConfigs, sourceInfo } from "../sources/index.js";
import { FeedParseError } from "../sources/rss.js";
import { tavilyApiKey } from "../sources/tavily.js";
import { pLimit } from "../util/concurrency.js";
import { normalizeUrl, parseHttpUrl, sha256Hex } from "../util/hash.js";
import { HttpError } from "../util/http.js";
import { configureLog } from "../util/log.js";
import { type Prompter, PromptCancelled, createClackPrompter } from "../util/prompter.js";
import type { Item } from "../types.js";
import { collapseWhitespace, displayLine, plural, stripControlChars } from "../util/text.js";

const MAX_PROBLEMS = 20;
const MAX_EXCLUDE = 30;
const MAX_TYPED_QUERIES = 10;
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
}

type FeedInput = NonNullable<SourcesInput["feeds"]>[number];
type QueryInput = NonNullable<SourcesInput["queries"]>[number];
type FoundRepo = Extract<RepoCheck, { status: "found" }>;
type QuerySuggestion = { query: string; topic: NonNullable<QueryInput["topic"]>; hint?: string };
/** Settles either way, so nobody has to wait for it until Claude is needed. */
type LlmLookup = Promise<{ client: LlmClient } | { error: unknown }>;

export interface InitOptions {
  configDir?: string;
  /** A proposal an agent wrote from the project (see --print-prompt), used as the defaults. */
  from?: string;
  /** Print the prompt that asks an agent for a proposal, and ask nothing. */
  printPrompt?: boolean;
}

export async function runInit(opts: InitOptions = {}, deps: Partial<InitDeps> = {}): Promise<void> {
  if (opts.printPrompt) {
    if (opts.from !== undefined) throw new ConfigError("--print-prompt and --from cannot be used together");
    // Asks nothing, so it works in a pipe: init --print-prompt | claude -p ...
    (deps.stdout ?? ((s: string) => void process.stdout.write(s)))(DISCOVERY_PROMPT);
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
  try {
    await init(opts.configDir ?? DEFAULT_CONFIG_DIR, deps, proposal);
  } finally {
    restoreLog();
  }
}

async function init(dir: string, deps: Partial<InitDeps>, proposal: Proposal | undefined): Promise<void> {
  const p = deps.prompter ?? createClackPrompter();
  const checkIgnored = deps.checkIgnored ?? gitCheckIgnored;
  const env = deps.env ?? process.env;
  const { signal } = deps;

  p.intro("pochi init");
  // Asked first so nobody answers every question only to be refused at the end.
  const existing = await existingConfig(dir);
  if (existing.length > 0) {
    const overwrite = await p.confirm({ message: `Overwrite ${existing.join(" and ")}?`, initialValue: false });
    if (!overwrite) throw new PromptCancelled();
  }
  if (proposal) noteProposal(p, proposal);

  let contextInput = await askContext(p, proposal);
  // The prompts read the defaults (language, llm) the parsed context fills in.
  let context = ContextSchema.parse(contextInput);
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
    const session = newSession(p, context, { llm, env, signal });
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
        proposal.queries.map((q) => ({ query: q.query, topic: q.topic, hint: q.evidence || undefined })),
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
  // Nothing touches the disk until every answer is in, so a cancel above leaves no trace.
  const { contextPath, sourcesPath } = await writeConfig(dir, { context: contextInput, sources }, { overwrite: true });

  const paths = [contextPath, sourcesPath];
  const ignored = await checkIgnored(paths);
  paths.forEach((path, i) => {
    if (ignored[i] === false) {
      p.warn(`${path} is not ignored by git; add ${join(dir, "*.yml")} to .gitignore before committing.`);
    }
    if (ignored[i] === undefined) p.note(`Could not check whether git ignores ${path}.`);
  });
  for (const name of ["POCHI_CONTEXT_YAML", "POCHI_SOURCES_YAML"]) {
    if (env[name]?.trim()) p.warn(`${name} is set and takes precedence over the files just written.`);
  }

  const configDir = dir === DEFAULT_CONFIG_DIR ? "" : ` --config-dir ${shellQuote(dir)}`;
  const types = new Set(context.notify.channels.map((c) => c.type));
  p.note(
    [
      `node dist/pochi.mjs run --dry-run${configDir}`,
      // Files stay on the machine that runs pochi, so a file-only setup is run locally, not in Actions.
      ...(types.has("slack")
        ? [
            `gh secret set POCHI_CONTEXT_YAML < ${shellQuote(contextPath)}`,
            `gh secret set POCHI_SOURCES_YAML < ${shellQuote(sourcesPath)}`,
            `gh secret set SLACK_WEBHOOK_URL`,
            `gh secret set ANTHROPIC_API_KEY`,
            `node dist/pochi.mjs schedule install --backend github${configDir}`,
          ]
        : [`node dist/pochi.mjs run${configDir}`, `node dist/pochi.mjs schedule install${configDir}`]),
    ].join("\n"),
    "Next steps",
  );
  p.outro(`Wrote ${contextPath} and ${sourcesPath}`);
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

async function askContext(p: Prompter, proposal?: Proposal): Promise<ContextInput> {
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

  const channels = await askChannels(p);

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

// Asked again until one is picked: a run has to deliver somewhere.
async function askChannels(p: Prompter): Promise<ChannelInput[]> {
  for (;;) {
    const picked = await p.multiselect({
      message: "Where should the briefing go? (space to toggle)",
      options: CHANNELS.map((c) => ({ ...c })),
      initialValues: ["slack"],
    });
    if (picked.length > 0) return picked.map((type) => ({ type }));
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
  tavilyNoted?: boolean;
}

export function newSession(
  p: Prompter,
  context: Context,
  opts: { llm?: LlmClient | LlmLookup; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
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
  };
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
  const wanted = await p.confirm({
    message: "Ask Claude for ideas from technology, design, marketing and industry angles you may have missed?",
    initialValue: true,
  });
  if (!wanted) return none;
  const llm = await getLlm(s);
  if (!llm) return none;
  let reply: IdeaSuggestionOutput;
  try {
    reply = await p.spin("Asking Claude for ideas", () => llm.generate(ideaSuggestionRequest(s.context), { signal }), signal);
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
  // None picked to begin with: each brings more news every morning.
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
      idea.queries.slice(0, MAX_IDEA_QUERIES).map((query) => ({ query, topic: "news" as const, hint: `idea: ${idea.perspective}` })),
    ),
  };
}

/**
 * Asks for feeds and queries, fetches the latest item of each and keeps the ones the user wants
 * to watch. Repeats until at least one is kept, since sources.yml needs one.
 */
export async function askSources(s: SourceSession, proposed: FeedInput[] = []): Promise<SourcesInput> {
  // Proposed feeds were claimed already; the first trial fetch tries them with the typed ones.
  let pending = proposed;
  for (;;) {
    const feeds = await askFeeds(s, pending);
    pending = [];
    const queries = await askQueries(s);
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
        // sources.yml needs a source; queries, if any, are asked next.
        ...(count > 0 || tavilyApiKey(s.env) ? [{ value: "done" as const, label: "Done" }] : []),
      ],
    });
    if (kind === "done") return added;

    const feed = kind === "repo" ? await askRepo(s) : await askSite(s);
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
    else p.warn(`Already added: ${displayLine(feed.name, SHOWN_MAX_CHARS)}; skipped.`);
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

async function askQueries(s: SourceSession): Promise<QueryInput[]> {
  const { p, signal } = s;
  // A run reads the same key (from process.env, which env is outside tests), so a query asked
  // for here is one a run can fetch.
  if (!tavilyApiKey(s.env)) {
    const proposed = (s.suggestions?.length ?? 0) + (s.ideaQueries?.length ?? 0);
    if (!s.tavilyNoted) {
      p.note(
        `TAVILY_API_KEY is not set, so web search queries are skipped${proposed > 0 ? ` (${plural(proposed, "proposed query", "proposed queries")} left out)` : ""}.`,
      );
    }
    s.tavilyNoted = true;
    return [];
  }
  if (!s.tavilyNoted) p.note("Web search queries use Tavily: each costs one credit a run, and one now to try it.");
  s.tavilyNoted = true;

  const llm = s.suggestions === undefined ? await getLlm(s) : undefined;
  if (llm) {
    try {
      const reply = await p.spin(
        "Asking Claude for search queries",
        () => llm.generate(querySuggestionRequest(s.context), { signal }),
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
      s.suggestions = [];
    }
  }

  // None picked to begin with, proposed or not: each costs a credit every morning.
  const candidates: QuerySuggestion[] = [];
  const offered = cleanSuggestions([...(s.suggestions ?? []), ...(s.ideaQueries ?? [])]).filter(
    (q) => !s.keys.has(queryKey(q.query)),
  );
  let addOwn = true;
  if (offered.length > 0) {
    const picked = await p.multiselect({
      message: "Search queries to run every morning (space to select)",
      options: offered.map((q) => ({
        value: q.query,
        label: displayLine(q.query, SHOWN_MAX_CHARS),
        hint: q.hint && (displayLine(q.hint, HINT_MAX_CHARS) || undefined),
      })),
    });
    candidates.push(...offered.filter((q) => picked.includes(q.query)));
    addOwn = await askAddOwn(p, picked.length);
  }
  const typed = addOwn
    ? await askList(p, { message: "Add a search query", placeholder: "Qwen model release", min: 0, max: MAX_TYPED_QUERIES })
    : [];
  // Control characters alone clean to nothing.
  candidates.push(...typed.map(cleanQuery).filter((q) => q !== "").map((query) => ({ query, topic: "news" as const })));

  const added: QueryInput[] = [];
  for (const { query, topic } of candidates) {
    const id = queryIdFrom(query, s.ids);
    if (!claim(s, queryKey(query), id)) {
      p.warn(`Already added: ${displayLine(query, SHOWN_MAX_CHARS)}; skipped.`);
      continue;
    }
    added.push({ id, query, topic });
  }
  return added;
}

/** Shows the latest item of each source and keeps those the user wants to watch. */
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
    }
    if (!(await p.confirm({ message: `Watch ${label} every morning?`, initialValue: ok }))) rejected.add(id);
  }

  // A rejected source may be added again later, perhaps another way.
  for (const source of [...feeds, ...queries]) {
    if (!rejected.has(source.id)) continue;
    s.ids.delete(source.id);
    s.keys.delete(keyOf(source));
  }
  return { feeds: feeds.filter((f) => !rejected.has(f.id)), queries: queries.filter((q) => !rejected.has(q.id)) };
}

// GitHub treats owner/repo case-insensitively; feed URLs compare as the pipeline dedupes them.
function keyOf(source: FeedInput | QueryInput): string {
  if ("query" in source) return queryKey(source.query);
  return source.type === "github" ? repoKey(source.repo) : feedKey(source.url);
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
