import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { ConfigError, type LoadedConfig, loadConfig } from "../config/load.js";
import { ExitCode, type ExitCodeValue, PochiError } from "../errors.js";
import { resolveLlm } from "../llm/adapter.js";
import type { SpawnFn } from "../llm/cli.js";
import { LlmError } from "../llm/schema.js";
import { fetchEach, type SourceConfig, sourceConfigs, sourceInfo } from "../sources/index.js";
import { tavilyApiKey } from "../sources/tavily.js";
import { inspectState, pruneState, resolveStatePath, StateError } from "../state/store.js";
import { configureLog, redact } from "../util/log.js";
import { displayLine, plural } from "../util/text.js";
import { toIsoDate } from "../util/time.js";
import { VERSION } from "../version.js";

// Feed titles and error messages come from outside; one long one should not flood the report.
const DETAIL_MAX_CHARS = 200;

// Only whether each is set is shown, never the value.
const ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "TAVILY_API_KEY",
  "SLACK_WEBHOOK_URL",
  "GITHUB_TOKEN",
  "POCHI_CONTEXT_YAML",
  "POCHI_SOURCES_YAML",
  "POCHI_STATE_PATH",
] as const;
const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/";

export type CheckStatus = "ok" | "warn" | "fail" | "skip" | "-";
export type Section = "Config" | "LLM" | "Environment" | "Notify" | "State" | "Sources";

export interface Check {
  section: Section;
  status: CheckStatus;
  label: string;
  detail: string;
  /** Set on failures: the exit code a run would end with for the same problem. */
  exitCode?: ExitCodeValue;
}

export interface DoctorOptions {
  configDir?: string;
  /** --state; POCHI_STATE_PATH and the default path follow, as in run. */
  state?: string;
  /** Also fetch every source and show its latest title. */
  fetch?: boolean;
}

export interface DoctorDeps {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  command?: string;
  signal?: AbortSignal;
  now?: Date;
  /** Receives the report, one line at a time. Defaults to stdout. */
  write?: (line: string) => void;
}

export interface DoctorResult {
  checks: Check[];
  /** The code of the first failed check in report order, 130 when interrupted, else 0. */
  exitCode: ExitCodeValue;
}

/**
 * Checks what a run needs without fetching (unless opts.fetch), calling the LLM or delivering
 * anything. Environment variables are reported as set or not; their values are never printed.
 */
export async function doctor(opts: DoctorOptions = {}, deps: DoctorDeps = {}): Promise<DoctorResult> {
  const write = deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const report = new Report((line) => write(redact(line)));
  const { signal } = deps;
  report.title(`pochi ${VERSION} doctor`);
  const interrupted = () => ({ checks: report.checks, exitCode: ExitCode.INTERRUPTED });
  try {
    const config = await checkConfig(report, opts.configDir);
    signal?.throwIfAborted();
    // Read while the LLM probe (up to 10 seconds) runs; it is still reported after it.
    const statePath = resolveStatePath({ flag: opts.state });
    const stateRead = readState(statePath);
    await checkLlm(report, config, deps);
    signal?.throwIfAborted();
    checkEnv(report);
    await checkNotify(report, config);
    await checkState(report, config, statePath, stateRead, deps.now ?? new Date());
    signal?.throwIfAborted();
    if (opts.fetch) await checkSources(report, config, signal);
  } catch (err) {
    if (signal?.aborted) return interrupted();
    throw err;
  }
  // A step that does not watch the signal may have finished after an abort.
  if (signal?.aborted) return interrupted();
  return { checks: report.checks, exitCode: report.summary() };
}

async function checkConfig(report: Report, configDir: string | undefined): Promise<LoadedConfig | undefined> {
  let config: LoadedConfig;
  try {
    config = await loadConfig({ configDir });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Validation messages name paths only, never values. One file with several issues is one problem.
    report.fail("Config", "config", withCause(err.message, err.cause), ExitCode.CONFIG);
    return undefined;
  }
  const { context, sources, origins } = config;
  report.ok("Config", "context", `${originText(origins.context)} (project ${context.project.name})`);
  report.ok(
    "Config",
    "sources",
    `${originText(origins.sources)} (${plural(sources.feeds.length, "feed")}, ${plural(sources.queries.length, "query", "queries")})`,
  );
  const queries = sources.queries.length;
  if (queries > 0 && !tavilyApiKey()) {
    // Same check as run: with no feeds, nothing would be fetched at all.
    if (sources.feeds.length === 0) {
      report.fail("Config", "queries", "no feeds, and the queries need TAVILY_API_KEY", ExitCode.CONFIG);
    } else {
      report.warn("Config", "queries", `${plural(queries, "query", "queries")} skipped without TAVILY_API_KEY`);
    }
  }
  return config;
}

async function checkLlm(report: Report, config: LoadedConfig | undefined, deps: DoctorDeps): Promise<void> {
  if (!config) {
    report.skip("LLM", "llm", "config is invalid");
    return;
  }
  try {
    const { client, models, cliVersion } = await resolveLlm(config.context.llm, {
      platform: deps.platform,
      spawn: deps.spawn,
      command: deps.command,
      signal: deps.signal,
    });
    const tiers = `triage ${models.triage} · analyze ${models.analyze}`;
    if (client.mode === "cli") {
      report.ok("LLM", "cli mode", `${cliVersion} · ${tiers}`);
    } else {
      // A key is only known to be valid once a request is billed, which doctor does not do.
      report.ok("LLM", "api mode", `${tiers} (the key is not checked against the API)`);
    }
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    report.fail("LLM", "llm", `${err.kind}: ${err.message}`, ExitCode.LLM);
  }
}

function checkEnv(report: Report): void {
  for (const name of ENV_NAMES) {
    const raw = process.env[name];
    const value = raw?.trim();
    // Whether SLACK_WEBHOOK_URL is needed depends on the channels, so Notify judges it.
    if (raw === undefined) {
      report.neutral("Environment", name, "not set");
    } else if (!value) {
      // Actions expands an unset secret to "".
      report.warn("Environment", name, "blank (treated as unset)");
    } else {
      report.ok("Environment", name, "set");
    }
  }
}

async function checkNotify(report: Report, config: LoadedConfig | undefined): Promise<void> {
  if (!config) {
    report.skip("Notify", "channels", "config is invalid");
    return;
  }
  for (const channel of config.context.notify.channels) {
    switch (channel.type) {
      case "slack": {
        const webhook = process.env.SLACK_WEBHOOK_URL?.trim();
        if (!webhook) report.warn("Notify", "slack", "SLACK_WEBHOOK_URL is not set (run needs it unless --dry-run)");
        else if (!webhook.startsWith(SLACK_WEBHOOK_PREFIX)) {
          report.warn("Notify", "slack", `SLACK_WEBHOOK_URL is not a ${SLACK_WEBHOOK_PREFIX} URL`);
        } else report.ok("Notify", "slack", "posts to SLACK_WEBHOOK_URL");
        break;
      }
      case "file": {
        const problem = await unwritableDir(channel.dir);
        if (problem) report.fail("Notify", "file", `${channel.dir}: ${problem}`, ExitCode.DELIVERY);
        else report.ok("Notify", "file", `writes ${channel.dir}/<date>.md`);
        break;
      }
    }
  }
}

/** Why a report could not be written to dir, or undefined. A missing dir is fine if it can be created. */
async function unwritableDir(dir: string): Promise<string | undefined> {
  for (let path = resolve(dir); ; path = dirname(path)) {
    try {
      if (!(await stat(path)).isDirectory()) return path === resolve(dir) ? "not a directory" : "cannot be created";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && dirname(path) !== path) continue;
      return "cannot be read";
    }
    try {
      await access(path, constants.W_OK);
      return undefined;
    } catch {
      return path === resolve(dir) ? "not writable" : "cannot be created";
    }
  }
}

type StateRead = { found: Awaited<ReturnType<typeof inspectState>> } | { error: unknown };

// Settled, so a failure is never an unhandled rejection while the LLM probe runs.
function readState(path: string): Promise<StateRead> {
  return inspectState(path).then(
    (found) => ({ found }),
    (error: unknown) => ({ error }),
  );
}

async function checkState(
  report: Report,
  config: LoadedConfig | undefined,
  path: string,
  pending: Promise<StateRead>,
  now: Date,
): Promise<void> {
  const read = await pending;
  if ("error" in read) {
    const err = read.error;
    if (!(err instanceof StateError)) throw err;
    report.fail("State", path, withCause(err.message, err.cause), ExitCode.INTERNAL);
    return;
  }
  const { found } = read;
  if (found.kind === "missing") {
    report.ok("State", path, "not found (the first run starts empty)");
    return;
  }
  if (found.kind === "invalid") {
    // run would move it aside and notify everything again, so this is worth stopping for.
    report.fail("State", path, "not a valid state file (a run moves it aside and starts empty)", ExitCode.INTERNAL);
    return;
  }
  const { entries } = found.state;
  const counts = { n: 0, i: 0, r: 0 };
  for (const entry of entries.values()) counts[entry.s]++;
  let detail = `${plural(entries.size, "entry", "entries")} (n ${counts.n} · i ${counts.i} · r ${counts.r})`;
  if (config) {
    const { ttlDays } = config.context.state;
    // A copy, so counting the expired entries changes nothing.
    const expired = pruneState({ entries: new Map(entries) }, ttlDays, toIsoDate(now));
    detail += `, ${expired} past ttlDays (${ttlDays})`;
  }
  report.ok("State", path, detail);
  if (found.dropped > 0) {
    report.warn("State", path, `${plural(found.dropped, "invalid entry", "invalid entries")} (a run drops them)`);
  }
}

async function checkSources(
  report: Report,
  config: LoadedConfig | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!config) {
    report.skip("Sources", "sources", "config is invalid");
    return;
  }
  const { sources } = config;
  const withQueries = tavilyApiKey() !== undefined;
  const configs = sourceConfigs(sources, withQueries);
  const outcomes = await fetchEach(configs, sources.defaults, { signal });
  if (signal && outcomes.some((o) => "aborted" in o)) throw signal.reason;
  for (const outcome of outcomes) {
    const label = sourceLabel(outcome.source);
    if ("error" in outcome) {
      report.fail("Sources", label, errorText(outcome.error));
    } else if ("items" in outcome) {
      const title = outcome.items[0]?.title;
      if (title === undefined) report.warn("Sources", label, "no items");
      else report.ok("Sources", label, title);
    }
  }
  if (!withQueries) {
    for (const q of sources.queries) report.skip("Sources", `${q.id} (tavily)`, "TAVILY_API_KEY is not set");
  }
  // Like run: some failing sources is fine, all of them is not.
  if (configs.length > 0 && outcomes.every((o) => "error" in o)) {
    report.fail("Sources", "sources", `all ${plural(configs.length, "source")} failed`, ExitCode.SOURCES);
  }
}

class Report {
  readonly checks: Check[] = [];
  private section: Section | undefined;

  constructor(private readonly out: (line: string) => void) {}

  title(text: string): void {
    this.out(text);
  }

  ok(section: Section, label: string, detail: string): void {
    this.add({ section, status: "ok", label, detail });
  }

  warn(section: Section, label: string, detail: string): void {
    this.add({ section, status: "warn", label, detail });
  }

  skip(section: Section, label: string, detail: string): void {
    this.add({ section, status: "skip", label, detail });
  }

  neutral(section: Section, label: string, detail: string): void {
    this.add({ section, status: "-", label, detail });
  }

  /** Without exitCode, the failure is shown and counted as non-fatal, but does not fail doctor. */
  fail(section: Section, label: string, detail: string, exitCode?: ExitCodeValue): void {
    this.add({ section, status: "fail", label, detail, exitCode });
  }

  /** Prints the closing line and returns the exit code of the first counted failure. */
  summary(): ExitCodeValue {
    const failed = this.checks.filter((c) => c.exitCode !== undefined);
    const nonFatal = this.checks.filter((c) => c.status === "fail" && c.exitCode === undefined).length;
    const warned = this.checks.filter((c) => c.status === "warn").length;
    const counts = [
      failed.length > 0 ? `${plural(failed.length, "problem")} found` : "No problems found",
      ...(nonFatal > 0 ? [plural(nonFatal, "non-fatal failure")] : []),
      ...(warned > 0 ? [plural(warned, "warning")] : []),
    ];
    this.out("");
    this.out(counts.join(", "));
    return failed[0]?.exitCode ?? ExitCode.OK;
  }

  private add(check: Check): void {
    if (check.section !== this.section) {
      this.section = check.section;
      this.out(check.section === "Sources" ? "Sources (--fetch)" : check.section);
    }
    this.checks.push(check);
    // A multi-line detail (a ConfigError's issues) continues under the detail column.
    const [first = "", ...rest] = check.detail.split("\n").map(oneLine);
    this.out(`  ${check.status.padEnd(5)} ${oneLine(check.label).padEnd(20)} ${first}`);
    for (const line of rest) this.out(`  ${"".padEnd(5)} ${"".padEnd(20)} ${line}`);
  }
}

export function doctorCommand(deps: DoctorDeps = {}): Command {
  return new Command("doctor")
    .description("Check the config, LLM, environment and state file without sending anything")
    .option("--config-dir <dir>", "directory holding context.yml and sources.yml")
    .option("--state <path>", "state file (default: POCHI_STATE_PATH, then state/notified.json)")
    .option("--fetch", "also fetch every source and show its latest title")
    .option("--verbose", "show debug logs")
    .action(async (opts: DoctorOptions & { verbose?: boolean }) => {
      // The report already says what the info logs would, so only warnings show unless asked.
      const restoreLog = configureLog({ level: opts.verbose ? "verbose" : "quiet" });
      const controller = new AbortController();
      const onSigint = () => controller.abort();
      // cli.ts passes the signal its own SIGINT/SIGTERM handling aborts; listen only without one.
      if (!deps.signal) process.once("SIGINT", onSigint);
      let result: DoctorResult;
      try {
        result = await doctor(opts, { ...deps, signal: deps.signal ?? controller.signal });
      } finally {
        process.off("SIGINT", onSigint);
        restoreLog();
      }
      if (result.exitCode === ExitCode.INTERRUPTED) throw new PochiError("interrupted", ExitCode.INTERRUPTED);
      if (result.exitCode !== ExitCode.OK) {
        const failed = result.checks.filter((c) => c.exitCode !== undefined).length;
        throw new PochiError(`doctor: ${plural(failed, "problem")} found`, result.exitCode);
      }
    });
}

function sourceLabel(source: SourceConfig): string {
  const { id, kind } = sourceInfo(source);
  return `${id} (${kind})`;
}

function originText(origin: LoadedConfig["origins"]["context"]): string {
  return origin.kind === "env" ? `env ${origin.name}` : origin.path;
}

function withCause(message: string, cause: unknown): string {
  return cause instanceof Error ? `${message}: ${cause.message}` : message;
}

// Fetch errors are built from status codes and redacted URLs, not from response bodies.
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Titles and messages from remote sources could otherwise carry ANSI/OSC sequences to the terminal.
function oneLine(s: string): string {
  return displayLine(s, DETAIL_MAX_CHARS);
}
