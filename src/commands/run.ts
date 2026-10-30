import { styleText } from "node:util";
import { ConfigError, loadConfig } from "../config/load.js";
import type { Context } from "../config/schema.js";
import { ExitCode, PochiError } from "../errors.js";
import { resolveLlm as defaultResolveLlm } from "../llm/adapter.js";
import { createNotifiers } from "../notifiers/index.js";
import { buildSlackMessages, type SlackMessage } from "../notifiers/slack.js";
import { toText } from "../notifiers/text.js";
import type { Briefing, Delivery, Notifier } from "../notifiers/types.js";
import { type FilterResult, filterAndAnalyze } from "../pipeline/filter.js";
import { calendarOf, longestGapDays } from "../schedule/calendar.js";
import { collectAll, stateKeys } from "../sources/index.js";
import { tavilyApiKey } from "../sources/tavily.js";
import {
  emptyState,
  firstSeen,
  loadState,
  pruneState,
  record,
  resolveStatePath,
  type State,
  saveState,
  statusOf,
  touch,
} from "../state/store.js";
import type { Insight, Item } from "../types.js";
import { configureLog, log } from "../util/log.js";
import { isFancy, purple } from "../util/pochi-art.js";
import { displayLine } from "../util/text.js";
import { DAY_MS, daysBetween, parseDate, toIsoDate } from "../util/time.js";

export interface RunOptions {
  dryRun?: boolean;
  /** A path, or false for --no-state (neither read nor written). */
  state?: string | false;
  json?: boolean;
  configDir?: string;
  verbose?: boolean;
  quiet?: boolean;
}

/** Replaced in tests; the defaults are the real ones. */
export interface RunDeps {
  now?: () => Date;
  signal?: AbortSignal;
  stdout?: (s: string) => void;
  resolveLlm?: typeof defaultResolveLlm;
  retryDelayMs?: number;
  slackIntervalMs?: number;
}

/**
 * Config → collect → drop known items → triage → analyze → notify → save state. Returns on success
 * and throws a PochiError carrying the exit code otherwise. Everything that can fail without
 * fetching or billing (config, webhook, LLM) is checked first.
 */
export async function runCommand(opts: RunOptions, deps: RunDeps = {}): Promise<void> {
  try {
    await run(opts, deps);
  } catch (err) {
    // collectAll and the LLM probe rethrow the signal's reason; to the user that is an interrupt.
    if (deps.signal?.aborted && !(err instanceof PochiError)) throw interrupted();
    throw err;
  }
}

async function run(opts: RunOptions, deps: RunDeps): Promise<void> {
  if (opts.verbose && opts.quiet) throw new ConfigError("--verbose and --quiet cannot be used together");
  configureLog({ level: opts.verbose ? "verbose" : opts.quiet ? "quiet" : "normal" });
  const { signal } = deps;
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const now = deps.now?.() ?? new Date();
  const today = toIsoDate(now);
  const dryRun = opts.dryRun ?? false;

  const loaded = await loadConfig({ configDir: opts.configDir });
  const { sources } = loaded;
  let context = loaded.context;
  if (!opts.quiet && isFancy(process.stderr)) {
    const about = `· ${displayLine(context.project.name, 80)} · ${today}${dryRun ? " · dry run" : ""}`;
    process.stderr.write(`\n  ${purple("pochi")} ${styleText("dim", about)}\n\n`);
  }
  // A dry run delivers nothing, so it needs no webhook.
  const notifiers = dryRun ? [] : createNotifiers(context, { slackIntervalMs: deps.slackIntervalMs });
  if (sources.feeds.length === 0 && !tavilyApiKey()) {
    throw new ConfigError("sources.yml has only queries and TAVILY_API_KEY is not set, so there is nothing to fetch");
  }
  const { client } = await (deps.resolveLlm ?? defaultResolveLlm)(context.llm, { signal });

  // --no-state starts empty and saves nothing; a dry run reads the state but never writes it.
  const statePath = opts.state === false ? undefined : resolveStatePath({ flag: opts.state });
  const state = statePath === undefined ? emptyState() : await loadState(statePath, { now, readOnly: dryRun });
  // Resolved once, so every step (and the prompts) uses the same window.
  context = { ...context, state: { ...context.state, maxItemAgeDays: itemAgeDays(context, state, now) } };
  const maxAgeDays = context.state.maxItemAgeDays!;
  log.debug(`looking back ${maxAgeDays} days`);
  const pruned = pruneState(state, context.state.ttlDays, today);
  if (pruned > 0) log.debug(`removed ${pruned} expired state entries`);
  // The saved time is where the next run's since starts, so it moves on only once every item
  // collected was decided: one left undecided is not in the state and would fall outside the window.
  const save = async (filtered: FilterResult) => {
    if (statePath === undefined || dryRun) return;
    const kept = state.updatedAt ?? new Date(now.getTime() - maxAgeDays * DAY_MS);
    await saveState(state, statePath, { now: filtered.undecided.length === 0 ? now : kept });
  };

  const collected = await collectAll(sources, { signal, since: sinceLastRun(state, maxAgeDays, now) });
  if (collected.attempted > 0 && collected.failures.length === collected.attempted) {
    throw new PochiError(`all ${collected.attempted} sources failed`, ExitCode.SOURCES);
  }
  const { fresh, pretriaged } = sortKnown(state, collected.items, maxAgeDays, today);
  log.info(
    `collected ${collected.items.length} items: ${fresh.length} new, ${pretriaged.length} awaiting analysis`,
  );

  const filtered = await filterAndAnalyze(client, context, fresh, {
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

  const briefing: Briefing = {
    project: context.project.name,
    date: today,
    insights: filtered.insights,
    collected: collected.items.length,
    attempted: collected.attempted,
    failedSources: collected.failures.map((f) => f.sourceName),
    personality: context.notify.personality,
  };

  if (dryRun) {
    const hasSlack = context.notify.channels.some((c) => c.type === "slack");
    const messages = hasSlack ? buildSlackMessages(briefing, { postWhenEmpty: context.notify.postWhenEmpty }) : undefined;
    stdout(opts.json ? toJson(briefing, filtered, { dryRun, messages }) : toText(briefing));
    if (filtered.error) throw filtered.error;
    return;
  }

  const sent = await deliverAll(notifiers, briefing, signal);
  // Marked notified only once every channel has it, so a channel that failed gets it tomorrow.
  const delivered = new Set(
    briefing.insights.map((f) => f.item.id).filter((id) => sent.every(({ result }) => result.deliveredIds.includes(id))),
  );
  if (sent.length < notifiers.length) delivered.clear();
  recordFiltered(state, filtered, delivered, today);
  // A failed save after a delivery means tomorrow repeats it, so it wins over everything else (1).
  await save(filtered);
  if (opts.json) stdout(toJson(briefing, filtered, { dryRun, sent }));

  if (sent.some(({ result }) => result.aborted)) throw interrupted();
  // The LLM failed first and is likely to fail again tomorrow, so it is reported over the delivery.
  if (filtered.error) throw filtered.error;
  const failed = sent.filter(({ result }) => result.failures.length > 0);
  if (failed.length > 0) {
    const parts = failed.map(({ name, result }) => {
      const missed = new Set(result.failures.flatMap((f) => f.itemIds)).size;
      return `${name} (${missed} updates not delivered)`;
    });
    throw new PochiError(`delivery failed: ${parts.join(", ")}`, ExitCode.DELIVERY, {
      cause: failed[0]!.result.failures[0]!.error,
    });
  }
  log.info(`delivered ${delivered.size} updates to ${notifiers.map((n) => n.name).join(", ")}`);
}

/**
 * Delivers to each channel in turn; after an abort the rest are not tried. Checked before each,
 * since a channel that cannot be interrupted (a file) would otherwise still run after Ctrl-C.
 */
async function deliverAll(
  notifiers: readonly Notifier[],
  briefing: Briefing,
  signal: AbortSignal | undefined,
): Promise<{ name: string; result: Delivery }[]> {
  const sent: { name: string; result: Delivery }[] = [];
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

function interrupted(): PochiError {
  return new PochiError("interrupted", ExitCode.INTERRUPTED);
}

function toJson(
  b: Briefing,
  filtered: FilterResult,
  out: { dryRun: boolean; messages?: SlackMessage[]; sent?: { name: string; result: Delivery }[] },
): string {
  return `${JSON.stringify(
    {
      date: b.date,
      dryRun: out.dryRun,
      collected: b.collected,
      attempted: b.attempted,
      failedSources: b.failedSources,
      stats: filtered.stats,
      insights: b.insights.map(insightJson),
      ...(out.messages && { messages: out.messages.map((m) => m.payload) }),
      ...(out.sent && { delivered: Object.fromEntries(out.sent.map(({ name, result }) => [name, result.deliveredIds])) }),
      ...(filtered.error && { error: { kind: filtered.error.kind, message: filtered.error.message } }),
    },
    null,
    2,
  )}\n`;
}

function insightJson(f: Insight) {
  return {
    id: f.item.id,
    title: f.title,
    url: f.item.url,
    impact: f.impact,
    summary: f.summary,
    action: f.action,
    source: f.item.sourceName,
    publishedAt: f.item.publishedAt,
    related: (f.related ?? []).map((r) => ({ id: r.id, title: r.title, url: r.url, source: r.sourceName })),
  };
}
