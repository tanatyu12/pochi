import { ConfigError, loadConfig } from "../config/load.js";
import type { Context } from "../config/schema.js";
import { ExitCode, PochiError } from "../errors.js";
import { resolveLlm as defaultResolveLlm } from "../llm/adapter.js";
import { type Briefing, buildSlackMessages, type SlackMessage, type SlackResult, sendSlack } from "../notifiers/slack.js";
import { type FilterResult, filterAndAnalyze } from "../pipeline/filter.js";
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
import { daysBetween, parseDate, toIsoDate } from "../util/time.js";

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
 * Config → collect → drop known items → triage → analyze → Slack → save state. Returns on success
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

  const { context, sources } = await loadConfig({ configDir: opts.configDir });
  // Actions expands an unset secret to "", so blank counts as unset.
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim() || undefined;
  if (!dryRun && !webhookUrl) throw new ConfigError("SLACK_WEBHOOK_URL is not set (use --dry-run to print instead)");
  if (sources.feeds.length === 0 && !tavilyApiKey()) {
    throw new ConfigError("sources.yml has only queries and TAVILY_API_KEY is not set, so there is nothing to fetch");
  }
  const { client } = await (deps.resolveLlm ?? defaultResolveLlm)(context.llm, { signal });

  // --no-state starts empty and saves nothing; a dry run reads the state but never writes it.
  const statePath = opts.state === false ? undefined : resolveStatePath({ flag: opts.state });
  const state = statePath === undefined ? emptyState() : await loadState(statePath, { now, readOnly: dryRun });
  const pruned = pruneState(state, context.state.ttlDays, today);
  if (pruned > 0) log.debug(`removed ${pruned} expired state entries`);
  const save = async () => {
    if (statePath !== undefined && !dryRun) await saveState(state, statePath, { now });
  };

  const collected = await collectAll(sources, { signal });
  if (collected.attempted > 0 && collected.failures.length === collected.attempted) {
    throw new PochiError(`all ${collected.attempted} sources failed`, ExitCode.SOURCES);
  }
  const { fresh, pretriaged } = sortKnown(state, collected.items, context, today);
  log.info(
    `collected ${collected.items.length} items: ${fresh.length} new, ${pretriaged.length} awaiting analysis`,
  );

  const filtered = await filterAndAnalyze(client, context, fresh, {
    signal,
    pretriaged,
    retryDelayMs: deps.retryDelayMs,
  });
  if (filtered.aborted) {
    // The answers so far are paid for; insights not sent are analyzed again next time.
    recordFiltered(state, filtered, new Set(), today);
    await save();
    throw interrupted();
  }

  const briefing: Briefing = {
    project: context.project.name,
    date: today,
    insights: filtered.insights,
    collected: collected.items.length,
    attempted: collected.attempted,
    failedSources: collected.failures.map((f) => f.sourceName),
  };
  const messages = buildSlackMessages(briefing, { postWhenEmpty: context.notify.slack.postWhenEmpty });

  if (dryRun) {
    stdout(opts.json ? toJson(briefing, filtered, { messages }) : toText(briefing));
    if (filtered.error) throw filtered.error;
    return;
  }

  const sent = await sendSlack(webhookUrl!, messages, { signal, intervalMs: deps.slackIntervalMs });
  const delivered = new Set(sent.deliveredIds);
  recordFiltered(state, filtered, delivered, today);
  // A failed save after a delivery means tomorrow repeats it, so it wins over everything else (1).
  await save();
  if (opts.json) stdout(toJson(briefing, filtered, { sent }));

  if (sent.aborted) throw interrupted();
  // The LLM failed first and is likely to fail again tomorrow, so it is reported over Slack.
  if (filtered.error) throw filtered.error;
  if (sent.failures.length > 0) {
    const missed = sent.failures.reduce((n, f) => n + f.itemIds.length, 0);
    throw new PochiError(
      `Slack delivery failed for ${sent.failures.length} of ${messages.length} messages (${missed} updates not delivered)`,
      ExitCode.SLACK,
      { cause: sent.failures[0]!.error },
    );
  }
  log.info(`delivered ${delivered.size} updates to Slack`);
}

/**
 * Touches every known item. Those awaiting analysis (r) go to Analyze directly; the rest of the
 * known ones are dropped. New items older than maxItemAgeDays are recorded as irrelevant unseen.
 * Items still awaiting analysis maxItemAgeDays after they were first seen are given up on (i):
 * touch keeps them from expiring, so an item Slack keeps rejecting would otherwise be analyzed forever.
 */
function sortKnown(
  state: State,
  items: readonly Item[],
  context: Context,
  today: string,
): { fresh: Item[]; pretriaged: Item[] } {
  const fresh: Item[] = [];
  const pretriaged: Item[] = [];
  const maxAge = context.state.maxItemAgeDays;
  let stale = 0;
  let givenUp = 0;
  for (const item of items) {
    const keys = stateKeys(item);
    const status = statusOf(state, keys);
    if (status === "r" && daysBetween(firstSeen(state, keys)!, today) > maxAge) {
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
  if (givenUp > 0) log.info(`gave up on ${givenUp} items still not delivered ${maxAge} days after they were first seen`);
  return { fresh, pretriaged };
}

// An item without a date cannot be judged old, so it is treated as new.
function isStale(item: Item, maxAgeDays: number, today: string): boolean {
  const published = parseDate(item.publishedAt);
  return published !== undefined && daysBetween(toIsoDate(published), today) > maxAgeDays;
}

function recordFiltered(state: State, filtered: FilterResult, delivered: ReadonlySet<string>, today: string): void {
  for (const item of filtered.irrelevant) record(state, stateKeys(item), "i", today);
  for (const item of filtered.pending) record(state, stateKeys(item), "r", today);
  for (const { item } of filtered.insights) {
    record(state, stateKeys(item), delivered.has(item.id) ? "n" : "r", today);
  }
}

function interrupted(): PochiError {
  return new PochiError("interrupted", ExitCode.INTERRUPTED);
}

function toText(b: Briefing): string {
  const head = `Pochi · ${b.project} · ${b.date}\n`;
  const foot =
    `\n${b.collected} items from ${b.attempted} sources` +
    (b.failedSources.length > 0 ? `; failed: ${b.failedSources.join(", ")}` : "") +
    "\n";
  if (b.insights.length === 0) return `${head}\nNo relevant updates.\n${foot}`;
  const body = b.insights.map((f) =>
    [
      `[${f.impact}] ${f.title}`,
      `  ${f.item.url}`,
      ...(f.summary ? [`  ${f.summary}`] : []),
      ...(f.action ? [`  Action: ${f.action}`] : []),
      `  Source: ${f.item.sourceName}`,
    ].join("\n"),
  );
  return `${head}\n${body.join("\n\n")}\n${foot}`;
}

function toJson(
  b: Briefing,
  filtered: FilterResult,
  out: { messages?: SlackMessage[]; sent?: SlackResult },
): string {
  return `${JSON.stringify(
    {
      date: b.date,
      dryRun: out.messages !== undefined,
      collected: b.collected,
      attempted: b.attempted,
      failedSources: b.failedSources,
      stats: filtered.stats,
      insights: b.insights.map(insightJson),
      ...(out.messages && { messages: out.messages.map((m) => m.payload) }),
      ...(out.sent && { delivered: out.sent.deliveredIds }),
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
  };
}
