import type { Context, Impact } from "../config/schema.js";
import { analyzeRequest, shortId, triageRequest } from "../llm/prompts.js";
import { type GenerateRequest, type LlmClient, LlmError, type LlmErrorKind, type LlmTier } from "../llm/schema.js";
import type { Insight, Item } from "../types.js";
import { log } from "../util/log.js";
import { parseDate, sleep } from "../util/time.js";

// Analyze sends whole articles (up to maxContentChars each), so its batches are smaller than triage's.
export const ANALYZE_BATCH_SIZE = 15;

const IMPACT_RANK: Record<Impact, number> = { High: 0, Medium: 1, Low: 2 };
// Every later call would fail the same way, so these are not retried and stop the run.
const FATAL_KINDS: ReadonlySet<LlmErrorKind> = new Set(["auth", "unavailable"]);
// Caused by the batch itself, so resending it as is fails again; its halves are sent instead.
const SPLIT_KINDS: ReadonlySet<LlmErrorKind> = new Set(["max_tokens", "refusal", "invalid_output", "too_large"]);
// The SDK and claude have already retried with their own backoff; this gives a limit time to pass.
export const RETRY_DELAY_MS = 10_000;

export interface FilterResult {
  /** To notify: by impact (High first), then newest first. */
  insights: Insight[];
  /**
   * Recorded as state i: not relevant, below notify.slack.minImpact, or the one item a batch kept
   * failing on (refused, say), found by splitting the batch.
   */
  irrelevant: Item[];
  /** Not recorded, so the next run triages them again: failed batches, unanswered items, over maxItemsPerRun. */
  undecided: Item[];
  /** Recorded as state r: relevant, but Analyze failed or did not answer; the next run analyzes them. */
  pending: Item[];
  stats: {
    triageBatches: number;
    triageFailed: number;
    analyzeBatches: number;
    analyzeFailed: number;
    /** Items in irrelevant because they alone made their batch fail. */
    dropped: number;
  };
  /**
   * Set when every batch of a stage failed, or when an auth, unavailable or lasting rate_limit
   * error stopped the run. The caller records irrelevant and pending first (those answers are
   * paid for), then throws this (exit 3).
   */
  error?: LlmError;
}

/**
 * Triage in batches of maxItemsPerCall, then Analyze the relevant items, and the pretriaged ones
 * (state r), in batches of ANALYZE_BATCH_SIZE. A batch that fails transiently is retried once
 * after retryDelayMs; one that fails because of its content is split to find the item causing it.
 * Throws only the abort reason and errors that are not LlmErrors.
 */
export async function filterAndAnalyze(
  llm: LlmClient,
  context: Context,
  items: readonly Item[],
  {
    signal,
    retryDelayMs = RETRY_DELAY_MS,
    pretriaged = [],
  }: { signal?: AbortSignal; retryDelayMs?: number; pretriaged?: readonly Item[] } = {},
): Promise<FilterResult> {
  const result: FilterResult = {
    insights: [],
    irrelevant: [],
    undecided: [],
    pending: [],
    stats: { triageBatches: 0, triageFailed: 0, analyzeBatches: 0, analyzeFailed: 0, dropped: 0 },
  };
  if (items.length === 0 && pretriaged.length === 0) return result;
  const byNewest = newestFirst([...items, ...pretriaged]);

  // Only new items count: pretriaged ones skip triage, and their number is bounded by earlier runs.
  let selected: readonly Item[] = items;
  if (items.length > context.llm.maxItemsPerRun) {
    const newest = [...items].sort(byNewest);
    selected = newest.slice(0, context.llm.maxItemsPerRun);
    result.undecided.push(...newest.slice(context.llm.maxItemsPerRun));
    log.info(
      `${items.length} new items exceed llm.maxItemsPerRun (${context.llm.maxItemsPerRun}); the oldest ${items.length - selected.length} wait for the next run`,
    );
  }

  const run: StageRun = { llm, signal, retryDelayMs, dropped: result.irrelevant };
  const relevant: Item[] = [...pretriaged];
  const triage = await runStage(
    run,
    "triage",
    chunk(selected, context.llm.maxItemsPerCall),
    result.undecided,
    (batch) => triageRequest(context, batch),
    (batch, reply) => {
      const decisions = byShortId(batch, reply.decisions, "triage");
      return batch.filter((item, i) => {
        const decision = decisions.get(i);
        if (!decision) return true;
        (decision.relevant ? relevant : result.irrelevant).push(item);
        log.debug(
          `triage ${item.sourceId}/${item.id}: ${decision.relevant ? "relevant" : "not relevant"}: ${decision.reason}`,
        );
        return false;
      });
    },
  );

  const threshold = IMPACT_RANK[context.notify.slack.minImpact];
  const analyze = await runStage(
    run,
    "analyze",
    chunk(relevant, ANALYZE_BATCH_SIZE),
    result.pending,
    (batch) => analyzeRequest(context, batch),
    (batch, reply) => {
      const insights = byShortId(batch, reply.insights, "analyze");
      return batch.filter((item, i) => {
        const insight = insights.get(i);
        if (!insight) return true;
        if (IMPACT_RANK[insight.impact] > threshold) {
          result.irrelevant.push(item);
        } else {
          result.insights.push({
            item,
            title: insight.title.trim() || item.title,
            summary: insight.summary.trim(),
            impact: insight.impact,
            action: insight.action.trim(),
          });
        }
        return false;
      });
    },
  );

  result.stats = {
    triageBatches: triage.batches,
    triageFailed: triage.failed,
    analyzeBatches: analyze.batches,
    analyzeFailed: analyze.failed,
    dropped: triage.dropped + analyze.dropped,
  };
  result.error = stageError("triage", triage) ?? stageError("analyze", analyze);
  if (!result.error && run.fatal) {
    result.error = new LlmError(run.fatal.kind, `stopped after: ${run.fatal.message}`);
  }

  result.insights.sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || byNewest(a.item, b.item));
  return result;
}

interface StageRun {
  llm: LlmClient;
  signal: AbortSignal | undefined;
  retryDelayMs: number;
  /** Where an item goes that alone made its batch fail. */
  dropped: Item[];
  /**
   * Set by an auth or unavailable error, or a rate_limit that outlasted the retry; every batch
   * after it is skipped, in both stages.
   */
  fatal?: LlmError;
}

interface StageOutcome {
  batches: number;
  /** Batches that got no answer at all, not even for one of their halves. */
  failed: number;
  dropped: number;
  last?: LlmError;
}

/**
 * Runs each batch; items without an answer go to leftover. apply takes a reply and returns the
 * items it had no answer for. A reply answering none of them counts as invalid output.
 */
async function runStage<T>(
  run: StageRun,
  stage: LlmTier,
  batches: Item[][],
  leftover: Item[],
  build: (batch: Item[]) => GenerateRequest<T>,
  apply: (batch: Item[], reply: T) => Item[],
): Promise<StageOutcome> {
  const outcome: StageOutcome = { batches: batches.length, failed: 0, dropped: 0 };

  /**
   * Undefined when the batch got at least one answer, else the error it failed with. A batch that
   * failed because of its content is left to the caller; any other failure goes to leftover.
   */
  const attempt = async (batch: Item[], label: string): Promise<LlmError | undefined> => {
    if (run.fatal) {
      outcome.last = run.fatal;
      leftover.push(...batch);
      return run.fatal;
    }
    let err: LlmError;
    try {
      const reply = await generateWithRetry(run, build(batch), label);
      const unanswered = apply(batch, reply);
      if (unanswered.length < batch.length) {
        leftover.push(...unanswered);
        return undefined;
      }
      // apply recorded nothing, so the batch can be split like any other content failure.
      err = new LlmError("invalid_output", `the reply answered none of the batch's ids (${label})`);
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      err = e;
    }
    outcome.last = err;
    if (SPLIT_KINDS.has(err.kind)) return err;
    // A rate_limit here has already been retried once, so the limit is not about to lift.
    if (FATAL_KINDS.has(err.kind) || err.kind === "rate_limit") run.fatal = err;
    leftover.push(...batch);
    log.warn(`${label} failed; its ${batch.length} items wait for the next run`, err);
    return err;
  };

  /**
   * Sends both halves of a batch that failed because of its content, and whether any item got an
   * answer. When only one half fails that way, the cause is in it, so it is split again until one
   * item is left, which goes to dropped. When both do, the cause is not one item (a model that
   * writes too much, say), so splitting stops and their items wait for the next run.
   */
  const bisect = async (batch: Item[], label: string): Promise<boolean> => {
    log.debug(`${label} failed because of its content; sending its ${batch.length} items in halves`);
    const middle = Math.ceil(batch.length / 2);
    const halves = [batch.slice(0, middle), batch.slice(middle)];
    const errors: (LlmError | undefined)[] = [];
    for (const [i, half] of halves.entries()) errors.push(await attempt(half, `${label} (part ${i + 1})`));
    const answered = errors.some((e) => e === undefined);
    const onContent = halves.filter((_, i) => errors[i] !== undefined && SPLIT_KINDS.has(errors[i].kind));
    if (onContent.length === 0) return answered;
    if (onContent.length === 2) {
      for (const half of onContent) leftover.push(...half);
      log.warn(
        `${label}: both halves failed, so no one item is the cause; its ${batch.length} items wait for the next run`,
      );
      return answered;
    }
    const half = onContent[0]!;
    const part = halves.indexOf(half) + 1;
    if (half.length > 1) return (await bisect(half, `${label} (part ${part})`)) || answered;
    // Only an answered other half shows that this item, not the model, is the cause.
    const item = half[0]!;
    if (!answered) {
      leftover.push(item);
      return false;
    }
    run.dropped.push(item);
    outcome.dropped++;
    log.warn(`${label}: ${item.sourceId}/${item.id} alone makes the request fail; recorded as irrelevant`);
    return answered;
  };

  for (const [n, batch] of batches.entries()) {
    const label = `${stage} batch ${n + 1}/${batches.length}`;
    const err = await attempt(batch, label);
    if (!err) continue;
    if (SPLIT_KINDS.has(err.kind)) {
      // A batch of one is not split: nothing shows that its item, rather than the model, is the cause.
      if (batch.length > 1 && (await bisect(batch, label))) continue;
      if (batch.length === 1) {
        leftover.push(...batch);
        log.warn(`${label} failed; its item waits for the next run`, err);
      }
    }
    outcome.failed++;
  }
  return outcome;
}

// Only transient LlmErrors are retried: an abort is the caller's decision, anything else is a bug.
async function generateWithRetry<T>(run: StageRun, req: GenerateRequest<T>, label: string): Promise<T> {
  try {
    return await run.llm.generate(req, { signal: run.signal });
  } catch (err) {
    if (!(err instanceof LlmError) || FATAL_KINDS.has(err.kind) || SPLIT_KINDS.has(err.kind)) throw err;
    if (run.signal?.aborted) throw run.signal.reason;
    log.debug(`${label} failed (${err.kind}); retrying once in ${run.retryDelayMs}ms`);
    await sleep(run.retryDelayMs, run.signal);
    return await run.llm.generate(req, { signal: run.signal });
  }
}

function stageError(stage: LlmTier, outcome: StageOutcome): LlmError | undefined {
  if (outcome.batches === 0 || outcome.failed < outcome.batches || !outcome.last) return undefined;
  const batches = outcome.batches === 1 ? "the only batch" : `all ${outcome.batches} batches`;
  return new LlmError(outcome.last.kind, `${stage}: ${batches} failed (last: ${outcome.last.message})`);
}

/**
 * Maps answers back to batch positions by their short id. Ids the batch never had are dropped,
 * and only the first answer for an id counts.
 */
function byShortId<A extends { id: string }>(batch: readonly Item[], answers: readonly A[], stage: LlmTier) {
  const positions = new Map(batch.map((_, i) => [shortId(i), i]));
  const found = new Map<number, A>();
  let unknown = 0;
  let duplicate = 0;
  for (const answer of answers) {
    const i = positions.get(answer.id.trim());
    if (i === undefined) unknown++;
    else if (found.has(i)) duplicate++;
    else found.set(i, answer);
  }
  if (unknown > 0) log.debug(`${stage}: dropped ${unknown} answers with unknown ids`);
  if (duplicate > 0) log.debug(`${stage}: dropped ${duplicate} repeated answers`);
  const missing = batch.length - found.size;
  if (missing > 0) log.info(`${stage}: ${missing} of ${batch.length} items got no answer; they wait for the next run`);
  return found;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

/**
 * Newest first, undated last; Array.prototype.sort is stable, so ties keep their order. Each date
 * is parsed once here rather than on every comparison.
 */
function newestFirst(items: readonly Item[]): (a: Item, b: Item) => number {
  const published = new Map(items.map((item) => [item, parseDate(item.publishedAt)?.getTime()]));
  return (a, b) => {
    const ta = published.get(a);
    const tb = published.get(b);
    if (ta === undefined || tb === undefined) return ta === tb ? 0 : ta === undefined ? 1 : -1;
    return tb - ta;
  };
}
