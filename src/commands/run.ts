import { styleText } from "node:util";
import { ConfigError, loadConfig } from "../config/load.js";
import { PochiError } from "../errors.js";
import { resolveLlm as defaultResolveLlm } from "../llm/adapter.js";
import { createNotifiers } from "../notifiers/index.js";
import { buildSlackMessages, type SlackMessage } from "../notifiers/slack.js";
import { toText } from "../notifiers/text.js";
import type { Briefing } from "../notifiers/types.js";
import { briefingError, interrupted, runBriefing, type Sent } from "../pipeline/briefing.js";
import type { FilterResult } from "../pipeline/filter.js";
import { tavilyApiKey } from "../sources/tavily.js";
import { fileStateStore, memoryStateStore, resolveStatePath } from "../state/store.js";
import type { Insight } from "../types.js";
import { configureLog, log } from "../util/log.js";
import { isFancy, purple } from "../util/pochi-art.js";
import { displayLine } from "../util/text.js";
import { toIsoDate } from "../util/time.js";

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
 * Config → runBriefing → print. Returns on success and throws a PochiError carrying the exit code
 * otherwise. Everything that can fail without fetching or billing (config, webhook, LLM) is
 * checked before runBriefing starts.
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
  const dryRun = opts.dryRun ?? false;

  const { context, sources } = await loadConfig({ configDir: opts.configDir });
  if (!opts.quiet && isFancy(process.stderr)) {
    const about = `· ${displayLine(context.project.name, 80)} · ${toIsoDate(now)}${dryRun ? " · dry run" : ""}`;
    process.stderr.write(`\n  ${purple("pochi")} ${styleText("dim", about)}\n\n`);
  }
  // A dry run delivers nothing, so it needs no webhook.
  const notifiers = dryRun ? [] : createNotifiers(context, { slackIntervalMs: deps.slackIntervalMs });
  if (sources.feeds.length === 0 && !tavilyApiKey()) {
    throw new ConfigError("sources.yml has only queries and TAVILY_API_KEY is not set, so there is nothing to fetch");
  }
  const { client } = await (deps.resolveLlm ?? defaultResolveLlm)(context.llm, { signal });
  // --no-state starts empty and saves nothing; a dry run reads the state but never writes it.
  const store =
    opts.state === false ? memoryStateStore() : fileStateStore(resolveStatePath({ flag: opts.state }), { readOnly: dryRun });

  const result = await runBriefing(
    { context, sources, llm: client, notifiers, store, dryRun },
    { now: () => now, signal, retryDelayMs: deps.retryDelayMs },
  );
  const { briefing, filtered, sent, delivered } = result;
  if (dryRun) {
    const hasSlack = context.notify.channels.some((c) => c.type === "slack");
    const messages = hasSlack ? buildSlackMessages(briefing, { postWhenEmpty: context.notify.postWhenEmpty }) : undefined;
    stdout(opts.json ? toJson(briefing, filtered, { dryRun, messages }) : toText(briefing));
  } else if (opts.json) {
    stdout(toJson(briefing, filtered, { dryRun, sent }));
  }
  const error = briefingError(result);
  if (error) throw error;
  if (!dryRun) log.info(`delivered ${delivered.size} updates to ${notifiers.map((n) => n.name).join(", ")}`);
}

function toJson(
  b: Briefing,
  filtered: FilterResult,
  out: { dryRun: boolean; messages?: SlackMessage[]; sent?: Sent[] },
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
