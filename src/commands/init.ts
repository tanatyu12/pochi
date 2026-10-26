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
  MAX_QUERY_SUGGESTIONS,
  MAX_REPO_CANDIDATES,
  queryId,
  querySuggestionRequest,
  repoInferenceRequest,
} from "../llm/prompts.js";
import { type LlmClient, LlmError } from "../llm/schema.js";
import { type DiscoveredFeed, FeedCheckError, discoverFeeds, isTransient } from "../sources/discover.js";
import { type RepoCheck, verifyRepo } from "../sources/github.js";
import { type SourceConfig, type SourceOutcome, fetchEach, sourceConfigs, sourceInfo } from "../sources/index.js";
import { FeedParseError } from "../sources/rss.js";
import { tavilyApiKey } from "../sources/tavily.js";
import { normalizeUrl, parseHttpUrl, sha256Hex } from "../util/hash.js";
import { HttpError } from "../util/http.js";
import { configureLog } from "../util/log.js";
import { type Prompter, PromptCancelled, createClackPrompter } from "../util/prompter.js";
import type { Item } from "../types.js";
import { collapseWhitespace, displayLine, plural, stripControlChars } from "../util/text.js";

const MAX_PROBLEMS = 20;
const MAX_EXCLUDE = 30;
const MAX_TYPED_QUERIES = 10;
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
}

type FeedInput = NonNullable<SourcesInput["feeds"]>[number];
type QueryInput = NonNullable<SourcesInput["queries"]>[number];
type FoundRepo = Extract<RepoCheck, { status: "found" }>;
/** Settles either way, so nobody has to wait for it until Claude is needed. */
type LlmLookup = Promise<{ client: LlmClient } | { error: unknown }>;

export async function runInit(opts: { configDir?: string } = {}, deps: Partial<InitDeps> = {}): Promise<void> {
  const isInteractive = deps.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  // Checked before anything is shown: a piped or CI run would otherwise hang on the first question.
  if (!isInteractive()) {
    throw new ConfigError("pochi init needs an interactive terminal; copy config/*.example.yml instead");
  }
  // The prompts show what matters; info lines from the fetchers would only break up the screen.
  const restoreLog = configureLog({ level: "quiet" });
  try {
    await init(opts.configDir ?? DEFAULT_CONFIG_DIR, deps);
  } finally {
    restoreLog();
  }
}

async function init(dir: string, deps: Partial<InitDeps>): Promise<void> {
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

  const contextInput = await askContext(p);
  // The prompts read the defaults (language, llm) the parsed context fills in.
  const context = ContextSchema.parse(contextInput);
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
    sources = await askSources(newSession(p, context, { llm, env, signal }));
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

  p.note(
    [
      `node dist/pochi.mjs run --dry-run${dir === DEFAULT_CONFIG_DIR ? "" : ` --config-dir ${shellQuote(dir)}`}`,
      `gh secret set POCHI_CONTEXT_YAML < ${shellQuote(contextPath)}`,
      `gh secret set POCHI_SOURCES_YAML < ${shellQuote(sourcesPath)}`,
      `gh secret set SLACK_WEBHOOK_URL`,
      `gh secret set ANTHROPIC_API_KEY`,
    ].join("\n"),
    "Next steps",
  );
  p.outro(`Wrote ${contextPath} and ${sourcesPath}`);
}

async function askContext(p: Prompter): Promise<ContextInput> {
  const name = await p.text({ message: "Project name", placeholder: "my-app", validate: required });
  const description = await p.text({
    message: "Describe the project in a sentence or two (optional)",
    placeholder: "A Next.js SaaS app with a Postgres backend",
  });
  const problems = await askList(p, {
    message: "What do you want to hear about?",
    placeholder: "Breaking changes in Next.js",
    min: 1,
    max: MAX_PROBLEMS,
  });
  const exclude = await askList(p, {
    message: "What should be dropped even if it looks related?",
    placeholder: "Funding news",
    min: 0,
    max: MAX_EXCLUDE,
  });
  const choice = await p.select({
    message: "Language for the summaries",
    options: [
      { value: "English", label: "English" },
      { value: "Japanese", label: "Japanese" },
      { value: "other", label: "Other" },
    ],
    initialValue: "English",
  });
  const language =
    choice === "other" ? (await p.text({ message: "Language", placeholder: "German", validate: required })).trim() : choice;

  return {
    version: 1,
    project: { name: name.trim(), description: description.trim() },
    problems,
    ...(exclude.length > 0 && { exclude }),
    language,
  };
}

// One text prompt per entry; an empty answer ends the list once min entries are in.
async function askList(
  p: Prompter,
  opts: { message: string; placeholder: string; min: number; max: number },
): Promise<string[]> {
  const items: string[] = [];
  while (items.length < opts.max) {
    const mandatory = items.length < opts.min;
    const answer = await p.text({
      message: `${opts.message} (${items.length + 1}/${opts.max}${mandatory ? "" : ", empty to finish"})`,
      placeholder: opts.placeholder,
      validate: mandatory ? required : undefined,
    });
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
  /** Asked once; later rounds offer what is left of them. */
  suggestions?: string[];
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

/**
 * Asks for feeds and queries, fetches the latest item of each and keeps the ones the user wants
 * to watch. Repeats until at least one is kept, since sources.yml needs one.
 */
export async function askSources(s: SourceSession): Promise<SourcesInput> {
  for (;;) {
    const feeds = await askFeeds(s);
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

async function askFeeds(s: SourceSession): Promise<FeedInput[]> {
  const added: FeedInput[] = [];
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
  if (check.status === "not_found") {
    p.warn(`${repo} was not found on GitHub.`);
    return undefined;
  }
  const current = check.movedTo ?? repo;
  if (check.movedTo) p.note(`${repo} moved to ${current}; watching that instead.`);
  if (check.status === "empty") {
    p.warn(`${current} has no releases or tags to watch.`);
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
  const { p, signal } = s;
  const raw = (
    await p.text({
      message: "Blog or feed URL (empty to go back)",
      placeholder: "https://simonwillison.net/",
      validate: (v) => (v.trim() === "" || parseHttpUrl(v.trim()) ? undefined : "Enter an absolute http(s) URL"),
    })
  ).trim();
  if (raw === "") return undefined;
  const url = parseHttpUrl(raw)!.href;
  // Typed as the feed itself; one found on a page is checked when it is added.
  if (s.keys.has(feedKey(url))) {
    p.warn("Already added; skipped.");
    return undefined;
  }

  let feeds: DiscoveredFeed[];
  try {
    feeds = await p.spin(`Looking for feeds on ${url}`, () => discoverFeeds(url, signal), signal);
  } catch (err) {
    throwIfCancelled(signal);
    // The page opened; a feed it led to did not.
    if (err instanceof FeedCheckError) {
      p.warn(`Could not check a feed on ${url}: ${errorLine(err)}`);
      // An advertised feed may be up again by the next run; a guessed path may be no feed at all.
      const shown = displayLine(err.feedUrl, SHOWN_MAX_CHARS);
      if (!err.advertised || !(await p.confirm({ message: `Add ${shown} anyway?`, initialValue: false }))) {
        return undefined;
      }
      return siteFeed(s, url, err.feedUrl);
    }
    if (!(err instanceof HttpError)) throw err;
    p.warn(`Could not open ${url}: ${errorLine(err)}`);
    // It may be up again by the next run; the user typed it, so let them decide.
    if (!isTransient(err) || !(await p.confirm({ message: `Add ${url} as a feed anyway?`, initialValue: false }))) {
      return undefined;
    }
    return siteFeed(s, url, url);
  }
  if (feeds.length === 0) {
    p.warn(`No feed found on ${url}.`);
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

async function askQueries(s: SourceSession): Promise<QueryInput[]> {
  const { p, signal } = s;
  // A run reads the same key (from process.env, which env is outside tests), so a query asked
  // for here is one a run can fetch.
  if (!tavilyApiKey(s.env)) {
    if (!s.tavilyNoted) p.note("TAVILY_API_KEY is not set, so web search queries are skipped.");
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
      const seen = new Set<string>();
      s.suggestions = reply.queries
        .map(cleanQuery)
        .filter((q) => q !== "" && once(seen, q.toLowerCase()))
        .slice(0, MAX_QUERY_SUGGESTIONS);
    } catch (err) {
      throwIfCancelled(signal);
      if (!(err instanceof LlmError)) throw err;
      llmFailed(s, err);
      s.suggestions = [];
    }
  }

  const candidates: string[] = [];
  const offered = (s.suggestions ?? []).filter((q) => !s.keys.has(queryKey(q)));
  if (offered.length > 0) {
    candidates.push(
      ...(await p.multiselect({
        message: "Search queries to run every morning (space to select)",
        options: offered.map((q) => ({ value: q, label: displayLine(q, SHOWN_MAX_CHARS) })),
      })),
    );
  }
  const typed = await askList(p, {
    message: "Add a search query",
    placeholder: "Qwen model release",
    min: 0,
    max: MAX_TYPED_QUERIES,
  });
  // Control characters alone clean to nothing.
  candidates.push(...typed.map(cleanQuery).filter((q) => q !== ""));

  const added: QueryInput[] = [];
  for (const query of candidates) {
    const id = queryIdFrom(query, s.ids);
    if (!claim(s, queryKey(query), id)) {
      p.warn(`Already added: ${displayLine(query, SHOWN_MAX_CHARS)}; skipped.`);
      continue;
    }
    added.push({ id, query, topic: "news" });
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
