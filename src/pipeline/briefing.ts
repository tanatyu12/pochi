import type { Context, Sources } from "../config/schema.js";
import { ExitCode, PochiError } from "../errors.js";
import type { LlmClient } from "../llm/schema.js";
import type { Briefing, Delivery, Notifier } from "../notifiers/types.js";
import { isMilestone } from "../notifiers/voice.js";
import { calendarOf, longestGapDays } from "../schedule/calendar.js";
import { type CollectResult, collectAll, stateKeys } from "../sources/index.js";
import {
  extrasOf,
  firstSeen,
  pruneState,
  record,
  type State,
  type StateStore,
  statusOf,
  touch,
} from "../state/store.js";
import type { Insight, Item } from "../types.js";
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
  /**
   * Empty for a dry run, which delivers nothing. Each name is the key the state records deliveries
   * under, so it must be stable between runs and unique among them (the channel type is).
   */
  notifiers: readonly Notifier[];
  store: StateStore;
  /** Collects and filters but neither delivers nor saves the state. */
  dryRun: boolean;
}

export interface BriefingDeps {
  now?: () => Date;
  /** The zone of the reader's clock when context.schedule.timezone is unset; the system's when left out. */
  timeZone?: string;
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
  /** Every insight of the run; a channel that already had some of them was sent only the rest. */
  briefing: Briefing;
  filtered: FilterResult;
  /** One per notifier tried, in order; empty for a dry run. */
  sent: Sent[];
  /** Item.id of the insights every channel has now, which are now marked notified. */
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
  // The state is dated in UTC days; the reader (and the model) is told the day on their own clock.
  const today = toIsoDate(now);
  const date = briefingDate(input.context, now, deps.timeZone);

  const state = await store.load({ now });
  // Resolved once, so every step (and the prompts) uses the same window.
  const context = {
    ...input.context,
    state: { ...input.context.state, maxItemAgeDays: itemAgeDays(input.context, state, now, deps.timeZone) },
  };
  const maxAgeDays = context.state.maxItemAgeDays;
  log.debug(`looking back ${maxAgeDays} days`);
  const pruned = pruneState(state, context.state.ttlDays, today);
  if (pruned > 0) log.debug(`removed ${pruned} expired state entries`);
  const window = sourceWindow(
    { maxAgeDays, set: input.context.state.maxItemAgeDays !== undefined, ttlDays: context.state.ttlDays },
    state,
    now,
  );

  let collected: CollectResult;
  try {
    collected = await collectAll(sources, { signal, since: window.since(undefined), sinceOf: window.since, env: deps.env });
  } catch (err) {
    // collectAll rethrows the signal's reason, which is not a PochiError.
    if (signal?.aborted) throw interrupted();
    throw err;
  }
  if (collected.attempted > 0 && collected.failures.length === collected.attempted) {
    throw new PochiError(`all ${collected.attempted} sources failed`, ExitCode.SOURCES);
  }
  const { fresh, pretriaged, analyzed } = sortKnown(state, collected.items, window.ageDays, today, maxAgeDays);
  log.info(
    `collected ${collected.items.length} items: ${fresh.length} new, ${pretriaged.length + analyzed.length} awaiting delivery`,
  );

  const filtered = await filterAndAnalyze(llm, context, fresh, {
    signal,
    pretriaged,
    analyzed,
    retryDelayMs: deps.retryDelayMs,
    today: date,
  });
  const channels = notifiers.map((n) => n.name);
  // Channels each insight had before this run, read before anything is recorded.
  const had = new Map(filtered.insights.map((f) => [f.item.id, extrasOf(state, stateKeys(f.item)).c ?? []]));
  // The saved time is where the next run's since starts. It always moves on: what is left waiting
  // is in the state, and holds back only the since of its own source.
  const save = async (reached: ReadonlyMap<string, readonly string[]>) => {
    if (dryRun) return;
    const waiting = recordFiltered(state, filtered, reached, channels, today);
    state.sources = sourceTimes(state, sources, collected, waiting, window, now);
    await store.save(state, { now });
  };

  if (filtered.aborted) {
    // The answers so far are paid for, and the analyses are kept for the next run to deliver.
    await save(had);
    throw interrupted();
  }

  // Counted only once it is delivered, so a failed delivery mentions the same number next time.
  const number = (state.briefings ?? 0) + 1;
  const briefing: Briefing = {
    project: context.project.name,
    date,
    insights: filtered.insights,
    collected: collected.items.length,
    attempted: collected.attempted,
    failedSources: collected.failures.map((f) => f.sourceName),
    personality: context.notify.personality,
    ...(filtered.insights.length > 0 && isMilestone(number) && { milestone: number }),
  };
  if (dryRun) return { briefing, filtered, sent: [], delivered: new Set() };

  // A channel that already has an insight (another one failed last time) is not sent it again.
  const briefingFor = (channel: string): Briefing => {
    const insights = briefing.insights.filter((f) => !had.get(f.item.id)?.includes(channel));
    const { milestone, ...rest } = briefing;
    return { ...rest, insights, ...(insights.length > 0 && milestone !== undefined && { milestone }) };
  };
  const sent = await deliverAll(notifiers, briefingFor, signal);
  // Recorded per channel, so a channel that failed (or was not reached before an interrupt) gets
  // the insight next time and the ones that have it do not get it twice.
  const reached = new Map(
    briefing.insights.map((f) => {
      const got = sent.filter(({ result }) => result.deliveredIds.includes(f.item.id)).map(({ name }) => name);
      return [f.item.id, [...new Set([...(had.get(f.item.id) ?? []), ...got])]];
    }),
  );
  const delivered = new Set(
    [...reached].filter(([, has]) => channels.every((c) => has.includes(c))).map(([id]) => id),
  );
  if (sent.some(({ result }) => result.deliveredIds.length > 0)) state.briefings = number;
  // A failed save after a delivery means tomorrow repeats it, so it wins over everything else (1).
  await save(reached);
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
 * The day the briefing is dated, on the clock of context.schedule.timezone (else timeZone, else
 * the system's): a run at 08:30 in Tokyo is that day's briefing, not the previous UTC day's.
 */
export function briefingDate(context: Context, now: Date, timeZone?: string): string {
  const zone = context.schedule.timezone ?? timeZone ?? systemTimeZone();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Delivers to each channel in turn; after an abort the rest are not tried. Checked before each,
 * since a channel that cannot be interrupted (a file) would otherwise still run after Ctrl-C.
 */
async function deliverAll(
  notifiers: readonly Notifier[],
  briefingFor: (channel: string) => Briefing,
  signal: AbortSignal | undefined,
): Promise<Sent[]> {
  const sent: Sent[] = [];
  for (const notifier of notifiers) {
    const result: Delivery = signal?.aborted
      ? { deliveredIds: [], failures: [], aborted: true }
      : await notifier.deliver(briefingFor(notifier.name), { signal });
    sent.push({ name: notifier.name, result });
    if (result.aborted) break;
  }
  return sent;
}

/**
 * Touches every known item. Those still untriaged (u) are triaged again, however old; those
 * awaiting delivery (r) skip triage, and go straight to delivery when their analysis is stored;
 * the rest of the known ones are dropped. New items older than their source's window are recorded
 * as irrelevant unseen. Items still u or r that long after they were first seen (and at least
 * MIN_RETRY_DAYS, so a channel down over a weekend loses nothing) are given up on (i): touch
 * keeps them from expiring, so an item a channel keeps rejecting would otherwise be analyzed forever.
 */
function sortKnown(
  state: State,
  items: readonly Item[],
  ageDays: (sourceId: string) => number,
  today: string,
  maxAge: number,
): { fresh: Item[]; pretriaged: Item[]; analyzed: Insight[] } {
  const fresh: Item[] = [];
  const pretriaged: Item[] = [];
  const analyzed = new Map<string, Insight>();
  const members: { item: Item; primary: string }[] = [];
  const retryDays = Math.max(maxAge, MIN_RETRY_DAYS);
  let stale = 0;
  let givenUp = 0;
  for (const item of items) {
    const keys = stateKeys(item);
    const status = statusOf(state, keys);
    if ((status === "r" || status === "u") && daysBetween(firstSeen(state, keys)!, today) > retryDays) {
      record(state, keys, "i", today);
      givenUp++;
    } else if (status !== undefined) {
      const { a, p } = extrasOf(state, keys);
      touch(state, keys, today);
      if (status === "u") fresh.push(item);
      else if (status === "r" && a) analyzed.set(item.id, { item, ...a });
      else if (status === "r" && p) members.push({ item, primary: p });
      else if (status === "r") pretriaged.push(item);
    } else if (isStale(item, ageDays(item.sourceId), today)) {
      record(state, keys, "i", today);
      stale++;
    } else {
      fresh.push(item);
    }
  }
  // A related report goes with its story; when the story itself was not collected, it is analyzed alone.
  for (const { item, primary } of members) {
    const story = analyzed.get(primary);
    if (story) (story.related ??= []).push(item);
    else pretriaged.push(item);
  }
  if (stale > 0) log.debug(`skipped ${stale} new items older than their source's window (${maxAge} days or more)`);
  if (givenUp > 0) log.info(`gave up on ${givenUp} items still not delivered ${retryDays} days after they were first seen`);
  return { fresh, pretriaged, analyzed: [...analyzed.values()] };
}

interface SourceWindow {
  /** Where a source's fetch starts; for undefined (or a source the state has no time for), the run's. */
  since: (sourceId: string | undefined) => Date;
  /** How many days back the source looks: maxItemAgeDays, or more for a source not fetched for longer. */
  ageDays: (sourceId: string) => number;
}

/**
 * Per source, a day before it was last fetched (so an entry dated just before it, or in another
 * time zone, is not missed; what was already seen is dropped by the state), falling back to the
 * last run. Never further back than the source's age in days, since older items are dropped
 * anyway; that age is maxItemAgeDays, or (unless maxItemAgeDays is set) back to the source's last
 * fetch when it failed since, as itemAgeDays does for missed runs. Without a saved run (the first
 * one), the whole window.
 */
function sourceWindow(
  window: { maxAgeDays: number; set: boolean; ttlDays: number },
  state: State,
  now: Date,
): SourceWindow {
  const { maxAgeDays, set, ttlDays } = window;
  const baseOf = (id: string | undefined) => (id === undefined ? undefined : state.sources?.get(id));
  const ageDays = (id: string | undefined): number => {
    const base = baseOf(id);
    if (base === undefined || set) return maxAgeDays;
    const missed = Math.ceil((now.getTime() - base.getTime()) / DAY_MS) + 1;
    return Math.min(Math.max(maxAgeDays, missed), ttlDays - 1);
  };
  const since = (id: string | undefined): Date => {
    const oldest = now.getTime() - ageDays(id) * DAY_MS;
    const base = baseOf(id) ?? state.updatedAt;
    if (base === undefined) return new Date(oldest);
    // A clock that was ahead must not push since past now.
    const last = Math.min(base.getTime(), now.getTime());
    return new Date(Math.max(last - DAY_MS, oldest));
  };
  return { since, ageDays };
}

/**
 * Where each configured source starts next time: now for a source fetched, held back to the oldest
 * dated item from it still waiting in the state (so the source still returns it); for a source that
 * failed, where it started this time (so what it published while down is not lost). Sources no
 * longer configured are dropped; a query skipped for lack of a key keeps its time.
 */
function sourceTimes(
  state: State,
  sources: Sources,
  collected: CollectResult,
  waiting: readonly Item[],
  window: SourceWindow,
  now: Date,
): Map<string, Date> {
  const configured = new Set([...sources.feeds.map((f) => f.id), ...sources.queries.map((q) => q.id)]);
  const times = new Map([...(state.sources ?? [])].filter(([id]) => configured.has(id)));
  const fetched = new Set(collected.fetched);
  for (const id of fetched) times.set(id, now);
  for (const item of waiting) {
    const published = parseDate(item.publishedAt);
    const time = times.get(item.sourceId);
    if (fetched.has(item.sourceId) && published && time && published < time) times.set(item.sourceId, published);
  }
  // since is a day before the time, so the time is a day after the since used.
  for (const { sourceId } of collected.failures) times.set(sourceId, new Date(window.since(sourceId).getTime() + DAY_MS));
  return times;
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
export function itemAgeDays(context: Context, state: State, now: Date, timeZone?: string): number {
  const set = context.state.maxItemAgeDays;
  if (set !== undefined) return set;
  const zone = context.schedule.timezone ?? timeZone ?? systemTimeZone();
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

/**
 * Records what the run decided, and returns the items left waiting in the state for a later run
 * (untriaged, unanalyzed, or not yet delivered everywhere). reached holds the channels that have
 * each insight; one that every channel has is notified, the others keep their analysis.
 */
function recordFiltered(
  state: State,
  filtered: FilterResult,
  reached: ReadonlyMap<string, readonly string[]>,
  channels: readonly string[],
  today: string,
): Item[] {
  const waiting: Item[] = [...filtered.undecided, ...filtered.pending];
  for (const item of filtered.irrelevant) record(state, stateKeys(item), "i", today);
  for (const item of filtered.undecided) record(state, stateKeys(item), "u", today);
  for (const item of filtered.pending) record(state, stateKeys(item), "r", today);
  for (const { item, related = [], title, summary, impact, action } of filtered.insights) {
    const has = [...(reached.get(item.id) ?? [])];
    // The other reports of a story were shown with it, so they share its fate.
    if (channels.length > 0 && channels.every((c) => has.includes(c))) {
      for (const one of [item, ...related]) record(state, stateKeys(one), "n", today);
      continue;
    }
    record(state, stateKeys(item), "r", today, { c: has, a: { title, summary, impact, action } });
    for (const one of related) record(state, stateKeys(one), "r", today, { c: has, p: item.id });
    waiting.push(item, ...related);
  }
  return waiting;
}
