import type { Context, Impact } from "../config/schema.js";
import { analyzeRequest, shortId, triageRequest } from "../llm/prompts.js";
import { type GenerateRequest, type LlmClient, LlmError, type LlmErrorKind, type LlmTier } from "../llm/schema.js";
import type { Insight, Item } from "../types.js";
import { log } from "../util/log.js";
import { parseDate } from "../util/time.js";

// Analyze sends whole articles (up to maxContentChars each), so its batches are smaller than triage's.
export const ANALYZE_BATCH_SIZE = 15;

const IMPACT_RANK: Record<Impact, number> = { High: 0, Medium: 1, Low: 2 };
// Every later call would fail the same way, so these stop the run's remaining batches.
const FATAL_KINDS: ReadonlySet<LlmErrorKind> = new Set(["auth", "unavailable"]);

export interface FilterResult {
  /** To notify: by impact (High first), then newest first. */
  insights: Insight[];
  /** Recorded as state i: not relevant, or below notify.slack.minImpact. */
  irrelevant: Item[];
  /** Not recorded, so the next run judges them again: failed batches, unanswered items, over maxItemsPerRun. */
  undecided: Item[];
  stats: { triageBatches: number; triageFailed: number; analyzeBatches: number; analyzeFailed: number };
}

/**
 * Triage in batches of maxItemsPerCall, then Analyze the relevant items in batches of
 * ANALYZE_BATCH_SIZE. A failed batch is retried once and its items left undecided; only when
 * every batch of a stage fails does this throw (LlmError, exit 3).
 */
export async function filterAndAnalyze(
  llm: LlmClient,
  context: Context,
  items: readonly Item[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<FilterResult> {
  const result: FilterResult = {
    insights: [],
    irrelevant: [],
    undecided: [],
    stats: { triageBatches: 0, triageFailed: 0, analyzeBatches: 0, analyzeFailed: 0 },
  };
  if (items.length === 0) return result;

  let selected: readonly Item[] = items;
  if (items.length > context.llm.maxItemsPerRun) {
    const newest = [...items].sort(byNewest);
    selected = newest.slice(0, context.llm.maxItemsPerRun);
    result.undecided.push(...newest.slice(context.llm.maxItemsPerRun));
    log.info(
      `${items.length} new items exceed llm.maxItemsPerRun (${context.llm.maxItemsPerRun}); the oldest ${items.length - selected.length} wait for the next run`,
    );
  }

  const run: StageRun = { llm, signal, undecided: result.undecided };
  const relevant: Item[] = [];
  const triage = await runStage(
    run,
    "triage",
    chunk(selected, context.llm.maxItemsPerCall),
    (batch) => triageRequest(context, batch),
    (batch, reply) => {
      const decisions = byShortId(batch, reply.decisions, "triage");
      for (const [i, item] of batch.entries()) {
        const decision = decisions.get(i);
        if (!decision) {
          result.undecided.push(item);
          continue;
        }
        (decision.relevant ? relevant : result.irrelevant).push(item);
        log.debug(
          `triage ${item.sourceId}/${item.id}: ${decision.relevant ? "relevant" : "not relevant"}: ${decision.reason}`,
        );
      }
    },
  );
  result.stats.triageBatches = triage.batches;
  result.stats.triageFailed = triage.failed;
  throwIfAllFailed("triage", triage);

  const threshold = IMPACT_RANK[context.notify.slack.minImpact];
  const analyze = await runStage(
    run,
    "analyze",
    chunk(relevant, ANALYZE_BATCH_SIZE),
    (batch) => analyzeRequest(context, batch),
    (batch, reply) => {
      const insights = byShortId(batch, reply.insights, "analyze");
      for (const [i, item] of batch.entries()) {
        const insight = insights.get(i);
        if (!insight) {
          result.undecided.push(item);
        } else if (IMPACT_RANK[insight.impact] > threshold) {
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
      }
    },
  );
  result.stats.analyzeBatches = analyze.batches;
  result.stats.analyzeFailed = analyze.failed;
  throwIfAllFailed("analyze", analyze);

  result.insights.sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || byNewest(a.item, b.item));
  return result;
}

interface StageRun {
  llm: LlmClient;
  signal: AbortSignal | undefined;
  undecided: Item[];
  /** Set by an auth or unavailable error; every batch after it is skipped, in both stages. */
  fatal?: LlmError;
}

interface StageOutcome {
  batches: number;
  failed: number;
  last?: LlmError;
}

async function runStage<T>(
  run: StageRun,
  stage: LlmTier,
  batches: Item[][],
  build: (batch: Item[]) => GenerateRequest<T>,
  apply: (batch: Item[], reply: T) => void,
): Promise<StageOutcome> {
  const outcome: StageOutcome = { batches: batches.length, failed: 0 };
  for (const [n, batch] of batches.entries()) {
    if (run.fatal) {
      outcome.failed++;
      outcome.last = run.fatal;
      run.undecided.push(...batch);
      continue;
    }
    let reply: T;
    try {
      reply = await generateWithRetry(run, build(batch), `${stage} batch ${n + 1}/${batches.length}`);
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      outcome.failed++;
      outcome.last = err;
      run.undecided.push(...batch);
      log.warn(`${stage} batch ${n + 1}/${batches.length} failed; its ${batch.length} items wait for the next run`, err);
      if (FATAL_KINDS.has(err.kind)) run.fatal = err;
      continue;
    }
    apply(batch, reply);
  }
  return outcome;
}

// Only LlmErrors are retried: an abort is the caller's decision, anything else is a bug.
async function generateWithRetry<T>(run: StageRun, req: GenerateRequest<T>, label: string): Promise<T> {
  try {
    return await run.llm.generate(req, { signal: run.signal });
  } catch (err) {
    if (!(err instanceof LlmError) || FATAL_KINDS.has(err.kind)) throw err;
    if (run.signal?.aborted) throw run.signal.reason;
    log.debug(`${label} failed (${err.kind}); retrying once`);
    return await run.llm.generate(req, { signal: run.signal });
  }
}

function throwIfAllFailed(stage: LlmTier, outcome: StageOutcome): void {
  if (outcome.batches === 0 || outcome.failed < outcome.batches || !outcome.last) return;
  const batches = outcome.batches === 1 ? "the only batch" : `all ${outcome.batches} batches`;
  throw new LlmError(outcome.last.kind, `${stage}: ${batches} failed (last: ${outcome.last.message})`);
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

// Newest first, undated last; Array.prototype.sort is stable, so ties keep their order.
function byNewest(a: Item, b: Item): number {
  const ta = parseDate(a.publishedAt)?.getTime();
  const tb = parseDate(b.publishedAt)?.getTime();
  if (ta === undefined || tb === undefined) return ta === tb ? 0 : ta === undefined ? 1 : -1;
  return tb - ta;
}
