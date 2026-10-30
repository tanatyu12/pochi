import type { Context, Sources } from "../config/schema.js";
import { ExitCode, PochiError } from "../errors.js";
import type { LlmClient } from "../llm/schema.js";
import type { Briefing, Delivery, Notifier } from "../notifiers/types.js";
import { isMilestone } from "../notifiers/voice.js";
import { calendarOf, longestGapDays } from "../schedule/calendar.js";
import { collectAll, stateKeys } from "../sources/index.js";
import { firstSeen, pruneState, record, type State, type StateStore, statusOf, touch } from "../state/store.js";
import type { Item } from "../types.js";
import { log } from "../util/log.js";
import { DAY_MS, daysBetween, parseDate, toIsoDate } from "../util/time.js";
import { type FilterResult, filterAndAnalyze } from "./filter.js";

/**
 * What a briefing runs on, already built and checked by the caller (the CLI, or anything else that
 * hosts Pochi), so nothing here reads files, the environment or the process.
 */
export interface BriefingInput {
  context: Context;
  sources: Sources;
  llm: LlmClient;
  /** Empty for a dry run, which delivers nothing. */
  notifiers: readonly Notifier[];
  store: StateStore;
  /** Collects and filters but neither delivers nor saves the state. */
  dryRun: boolean;
}

export interface BriefingDeps {
  now?: () => Date;
  signal?: AbortSignal;
  /** Where source secrets come from; process.env when left out. */
  env?: NodeJS.ProcessEnv;
  retryDelayMs?: number;
}

export interface Sent {
  name: string;
  result: Delivery;
}

export interface BriefingResult {
  briefing: Briefing;
  filtered: FilterResult;
  /** One per notifier tried, in order; empty for a dry run. */
  sent: Sent[];
  /** Item.id of the insights every channel received, which are now marked notified. */
  delivered: ReadonlySet<string>;
}

/**
 * Load state → collect → drop known items → triage → analyze → deliver → save state. Returns
 * what happened, also when the LLM or a channel failed (briefingError turns that into the error
 * to report); throws a PochiError when sources all fail, the state cannot be saved, or the run is
 * interrupted before delivery.
 */
export async function runBriefing(input: BriefingInput, deps: BriefingDeps = {}): Promise<BriefingResult> {
  const { sources, llm, notifiers, store, dryRun } = input;
  const { signal } = deps;
  const now = deps.now?.() ?? new Date();
  const today = toIsoDate(now);

  const state = await store.load({ now });
  // Resolved once, so every step (and the prompts) uses the same window.
  const context = {
    ...input.context,
    state: { ...input.context.state, maxItemAgeDays: itemAgeDays(input.context, state, now) },
  };
  const maxAgeDays = context.state.maxItemAgeDays;
  log.debug(`looking back ${maxAgeDays} days`);
  const pruned = pruneState(state, context.state.ttlDays, today);
  if (pruned > 0) log.debug(`removed ${pruned} expired state entries`);
  // The saved time is where the next run's since starts, so it moves on only once every item
  // collected was decided: one left undecided is not in the state and would fall outside the window.
  const save = async (filtered: FilterResult) => {
    if (dryRun) return;
    const kept = state.updatedAt ?? new Date(now.getTime() - maxAgeDays * DAY_MS);
    await store.save(state, { now: filtered.undecided.length === 0 ? now : kept });
  };

  const collected = await collectAll(sources, { signal, since: sinceLastRun(state, maxAgeDays, now), env: deps.env });
  if (collected.attempted > 0 && collected.failures.length === collected.attempted) {
    throw new PochiError(`all ${collected.attempted} sources failed`, ExitCode.SOURCES);
  }
  const { fresh, pretriaged } = sortKnown(state, collected.items, maxAgeDays, today);
  log.info(
    `collected ${collected.items.length} items: ${fresh.length} new, ${pretriaged.length} awaiting analysis`,
  );

  const filtered = await filterAndAnalyze(llm, context, fresh, {
    signal,
    pretriaged,
    retryDelayMs: deps.retryDelayMs,
    today,
  });
  if (filtered.aborted) {
    // The answers so far are paid for; insights not sent are analyzed again next time.
    recordFiltered(state, filtered, new Set(), today);
    await save(filtered);
    throw interrupted();
  }

  // Counted only once it is delivered, so a failed delivery mentions the same number next time.
  const number = (state.briefings ?? 0) + 1;
  const briefing: Briefing = {
    project: context.project.name,
    date: today,
    insights: filtered.insights,
    collected: collected.items.length,
    attempted: collected.attempted,
    failedSources: collected.failures.map((f) => f.sourceName),
    personality: context.notify.personality,
    ...(filtered.insights.length > 0 && isMilestone(number) && { milestone: number }),
  };
  if (dryRun) return { briefing, filtered, sent: [], delivered: new Set() };

  const sent = await deliverAll(notifiers, briefing, signal);
  // Marked notified only once every channel has it, so a channel that failed gets it tomorrow.
  const delivered = new Set(
    briefing.insights.map((f) => f.item.id).filter((id) => sent.every(({ result }) => result.deliveredIds.includes(id))),
  );
  if (sent.length < notifiers.length) delivered.clear();
  recordFiltered(state, filtered, delivered, today);
  if (delivered.size > 0) state.briefings = number;
  // A failed save after a delivery means tomorrow repeats it, so it wins over everything else (1).
  await save(filtered);
  return { briefing, filtered, sent, delivered };
}

/** The error a finished run should be reported with, or undefined when everything went through. */
export function briefingError({ filtered, sent }: BriefingResult): PochiError | undefined {
  if (sent.some(({ result }) => result.aborted)) return interrupted();
  // The LLM failed first and is likely to fail again tomorrow, so it is reported over the delivery.
  if (filtered.error) return filtered.error;
  const failed = sent.filter(({ result }) => result.failures.length > 0);
  if (failed.length === 0) return undefined;
  const parts = failed.map(({ name, result }) => {
    const missed = new Set(result.failures.flatMap((f) => f.itemIds)).size;
    return `${name} (${missed} updates not delivered)`;
  });
  return new PochiError(`delivery failed: ${parts.join(", ")}`, ExitCode.DELIVERY, {
    cause: failed[0]!.result.failures[0]!.error,
  });
}

export function interrupted(): PochiError {
  return new PochiError("interrupted", ExitCode.INTERRUPTED);
}

/**
 * Delivers to each channel in turn; after an abort the rest are not tried. Checked before each,
 * since a channel that cannot be interrupted (a file) would otherwise still run after Ctrl-C.
 */
async function deliverAll(notifiers: readonly Notifier[], briefing: Briefing, signal: AbortSignal | undefined): Promise<Sent[]> {
  const sent: Sent[] = [];
  for (const notifier of notifiers) {
    const result: Delivery = signal?.aborted
      ? { deliveredIds: [], failures: [], aborted: true }
      : await notifier.deliver(briefing, { signal });
    sent.push({ name: notifier.name, result });
    if (result.aborted) break;
  }
  return sent;
}

/**
 * Touches every known item. Those awaiting analysis (r) go to Analyze directly; the rest of the
 * known ones are dropped. New items older than maxAge days are recorded as irrelevant unseen.
 * Items still awaiting analysis that long after they were first seen (and at least
 * MIN_RETRY_DAYS, so a channel down over a weekend loses nothing) are given up on (i): touch
 * keeps them from expiring, so an item a channel keeps rejecting would otherwise be analyzed forever.
 */
function sortKnown(
  state: State,
  items: readonly Item[],
  maxAge: number,
  today: string,
): { fresh: Item[]; pretriaged: Item[] } {
  const fresh: Item[] = [];
  const pretriaged: Item[] = [];
  const retryDays = Math.max(maxAge, MIN_RETRY_DAYS);
  let stale = 0;
  let givenUp = 0;
  for (const item of items) {
    const keys = stateKeys(item);
    const status = statusOf(state, keys);
    if (status === "r" && daysBetween(firstSeen(state, keys)!, today) > retryDays) {
      record(state, keys, "i", today);
      givenUp++;
    } else if (status !== undefined) {
      touch(state, keys, today);
      if (status === "r") pretriaged.push(item);
    } else if (isStale(item, maxAge, today)) {
      record(state, keys, "i", today);
      stale++;
    } else {
      fresh.push(item);
    }
  }
  if (stale > 0) log.debug(`skipped ${stale} new items older than ${maxAge} days`);
  if (givenUp > 0) log.info(`gave up on ${givenUp} items still not delivered ${retryDays} days after they were first seen`);
  return { fresh, pretriaged };
}

/**
 * A day before the last run, so an entry dated just before it (or in another time zone) is not
 * missed; what was already seen is dropped by the state. Never further back than maxAge days,
 * since older items are dropped anyway. Without a saved run (the first one), the whole window.
 */
function sinceLastRun(state: State, maxAge: number, now: Date): Date {
  const oldest = now.getTime() - maxAge * DAY_MS;
  if (state.updatedAt === undefined) return new Date(oldest);
  // A clock that was ahead must not push since past now.
  const last = Math.min(state.updatedAt.getTime(), now.getTime());
  return new Date(Math.max(last - DAY_MS, oldest));
}

/** When the schedule cannot tell (no two runs in 5 years). */
const FALLBACK_ITEM_AGE_DAYS = 14;
const MIN_RETRY_DAYS = 14;

/**
 * How many days back a run looks: maxItemAgeDays when set; otherwise the schedule's longest gap
 * between runs and a day to spare (a weekly run gets the week since the last one, a daily one
 * about two days), or back to the last run when runs were missed. Kept short of ttlDays, or
 * expired state entries would come back as new items.
 */
export function itemAgeDays(context: Context, state: State, now: Date): number {
  const set = context.state.maxItemAgeDays;
  if (set !== undefined) return set;
  const zone = context.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const gap = longestGapDays(calendarOf(context.schedule), zone, now);
  const sinceLast =
    state.updatedAt === undefined ? 0 : Math.ceil((now.getTime() - state.updatedAt.getTime()) / DAY_MS);
  const days = gap === undefined ? FALLBACK_ITEM_AGE_DAYS : Math.max(gap, sinceLast) + 1;
  return Math.min(days, context.state.ttlDays - 1);
}

// An item without a date cannot be judged old, so it is treated as new.
function isStale(item: Item, maxAgeDays: number, today: string): boolean {
  const published = parseDate(item.publishedAt);
  return published !== undefined && daysBetween(toIsoDate(published), today) > maxAgeDays;
}

function recordFiltered(state: State, filtered: FilterResult, delivered: ReadonlySet<string>, today: string): void {
  for (const item of filtered.irrelevant) record(state, stateKeys(item), "i", today);
  for (const item of filtered.pending) record(state, stateKeys(item), "r", today);
  for (const { item, related = [] } of filtered.insights) {
    // The other reports of a story were shown with it, so they share its fate.
    const status = delivered.has(item.id) ? "n" : "r";
    for (const one of [item, ...related]) record(state, stateKeys(one), status, today);
  }
}
