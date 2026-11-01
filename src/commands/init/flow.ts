import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, configEnvOverrides, DEFAULT_CONFIG_DIR, parseContext } from "../../config/load.js";
import { type Context, ContextSchema, DomainSchema, type SourcesInput } from "../../config/schema.js";
import { existingConfig, writeConfig } from "../../config/write.js";
import { resolveLlm } from "../../llm/adapter.js";
import { type Proposal, readProposal } from "../../proposal/parse.js";
import { type Watchlist, discoveryPrompt } from "../../proposal/prompt.js";
import { configureLog } from "../../util/log.js";
import { type Prompter, PromptBack, PromptCancelled, createClackPrompter } from "../../util/prompter.js";
import { replayingPrompter } from "../../util/replay.js";
import { shellQuote } from "../../util/shell.js";
import { type ScheduleDeps, runsFromBundle } from "../schedule.js";
import { createInitCache } from "./cache.js";
import { askContext, noteProposal } from "./context.js";
import { addProposedFeeds } from "./feeds.js";
import { askIdeas } from "./ideas.js";
import { type QuerySuggestion, cleanQuery, cleanSuggestions, once } from "./keys.js";
import { askSchedule, askWhereToRun, install, offerInstall, runsPerMonth } from "./schedule.js";
import { lookUpLlm, newSession } from "./session.js";
import { gitCheckIgnored } from "./shell.js";
import { askSources } from "./sources.js";

const MAX_WATCHED = 10;

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

export interface InitOptions {
  configDir?: string;
  /** A proposal an agent wrote from the project (see --print-prompt), used as the defaults. */
  from?: string;
  /** Print the prompt that asks an agent for a proposal, and ask nothing. */
  printPrompt?: boolean;
  /** Who to follow (--competitor, --adopter, --news-site); every list may be empty or left out. */
  watch?: Partial<Watchlist>;
}

/** Cleans the names and checks the news sites; ConfigError (exit 2) for a site that is not a domain. */
function cleanWatchlist(watch: Partial<Watchlist> = {}): Watchlist {
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
      const suggestions = proposedSuggestions(proposal);
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
  // Only what the user agreed to overwrite: a file that appeared since is refused, not replaced.
  const { contextPath, sourcesPath } = await writeConfig(
    dir,
    { context: contextInput, sources },
    { overwrite: existing.length > 0 },
  );
  // Written: going back would change nothing on disk.
  p.freeze?.();

  await warnUnignored(p, dir, [contextPath, sourcesPath], checkIgnored);
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
  p.note(nextSteps({ configDir, contextPath, sourcesPath, onActions, installed }), "Next steps");
  p.outro(`Wrote ${contextPath} and ${sourcesPath}`);
}

/** The context.yml about to be overwritten, if it can be read. */
async function readPrevious(dir: string): Promise<Context | undefined> {
  const path = join(dir, "context.yml");
  try {
    return parseContext(await readFile(path, "utf8"), path);
  } catch {
    return undefined;
  }
}

/** The proposal's queries as suggestions, each hinted with the sites it keeps to and its evidence. */
function proposedSuggestions(proposal: Proposal): QuerySuggestion[] {
  return cleanSuggestions(
    proposal.queries.map((q) => ({
      query: q.query,
      topic: q.topic,
      // The sites lead, so a query limited to them is told apart from the same words unlimited.
      hint: [q.includeDomains && `on ${q.includeDomains.join(", ")}`, q.evidence].filter(Boolean).join(" · ") || undefined,
      includeDomains: q.includeDomains,
      proposed: true,
    })),
  );
}

async function warnUnignored(
  p: Prompter,
  dir: string,
  paths: string[],
  checkIgnored: InitDeps["checkIgnored"],
): Promise<void> {
  const ignored = await checkIgnored(paths);
  paths.forEach((path, i) => {
    if (ignored[i] === false) {
      p.warn(`${path} is not ignored by git; add ${join(dir, "*.yml")} to .gitignore before committing.`);
    }
    if (ignored[i] === undefined) p.note(`Could not check whether git ignores ${path}.`);
  });
}

/** The commands to run next; on Actions, the secrets come first. */
export function nextSteps(opts: {
  /** The --config-dir argument with a leading space, or "" for the default directory. */
  configDir: string;
  contextPath: string;
  sourcesPath: string;
  onActions: boolean;
  installed: boolean;
}): string {
  const { configDir } = opts;
  return [
    `node dist/pochi.mjs run --dry-run${configDir}`,
    ...(opts.onActions
      ? [
          `gh secret set POCHI_CONTEXT_YAML < ${shellQuote(opts.contextPath)}`,
          `gh secret set POCHI_SOURCES_YAML < ${shellQuote(opts.sourcesPath)}`,
          `gh secret set SLACK_WEBHOOK_URL`,
          `gh secret set ANTHROPIC_API_KEY`,
          `node dist/pochi.mjs schedule install --backend github${configDir}`,
        ]
      : [
          `node dist/pochi.mjs run${configDir}`,
          opts.installed ? `node dist/pochi.mjs schedule status${configDir}` : `node dist/pochi.mjs schedule install${configDir}`,
        ]),
  ].join("\n");
}
