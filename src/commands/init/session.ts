import type { Context } from "../../config/schema.js";
import type { resolveLlm } from "../../llm/adapter.js";
import { type LlmClient, LlmError } from "../../llm/schema.js";
import { EMPTY_WATCHLIST, type Watchlist } from "../../proposal/prompt.js";
import type { Item } from "../../types.js";
import { type Prompter, PromptCancelled } from "../../util/prompter.js";
import { displayLine } from "../../util/text.js";
import type { FeedInput, QueryInput, QuerySuggestion } from "./keys.js";

// Titles, notes and errors come from feeds, the model and the network; one line each is enough.
export const SHOWN_MAX_CHARS = 120;
export const HINT_MAX_CHARS = 60;
// An option value no repo or feed URL can take.
export const NONE = "none";

/** Settles either way, so nobody has to wait for it until Claude is needed. */
export type LlmLookup = Promise<{ client: LlmClient } | { error: unknown }>;

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

export function lookUpLlm(
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
export async function getLlm(s: SourceSession): Promise<LlmClient | undefined> {
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

// Auth and unavailable will not pass on the next call; anything else may.
export function llmFailed(s: SourceSession, err: LlmError): void {
  if (err.kind === "auth" || err.kind === "unavailable") {
    s.llm = undefined;
    s.p.warn(`Claude is not usable (${err.kind}); continuing without it.`);
  } else {
    s.p.warn(`Claude could not answer (${err.kind}).`);
  }
}

/** Records the source as added; false when it already was. */
export function claim(s: SourceSession, key: string, id: string): boolean {
  if (s.keys.has(key)) return false;
  s.keys.add(key);
  s.ids.add(id);
  return true;
}

// Like Promise.allSettled for one promise.
export function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

// A fetch cut short by Ctrl-C fails like any other; the signal tells them apart.
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PromptCancelled();
}

export function errorLine(err: unknown): string {
  return displayLine(err instanceof Error ? err.message : String(err), SHOWN_MAX_CHARS);
}
