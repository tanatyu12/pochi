import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { styleText } from "node:util";
import { Command } from "commander";
import { CONFIG_ENV_NAMES, type ConfigEnvName, ConfigError, type LoadedConfig, loadConfig } from "../config/load.js";
import { ExitCode, type ExitCodeValue, PochiError } from "../errors.js";
import { resolveLlm } from "../llm/adapter.js";
import type { SpawnFn } from "../llm/cli.js";
import { LlmError } from "../llm/schema.js";
import { fetchEach, type SourceConfig, sourceConfigs, sourceInfo } from "../sources/index.js";
import { slackWebhookUrl } from "../notifiers/slack.js";
import { tavilyApiKey } from "../sources/tavily.js";
import {
  type EntryStatus,
  inspectState,
  pruneState,
  resolveStatePath,
  STATE_PATH_ENV,
  type StateInspection,
  StateError,
} from "../state/store.js";
import { isEnoent } from "../util/fs.js";
import { configureLog, redact, type SecretEnvName } from "../util/log.js";
import { isFancy, purple } from "../util/pochiArt.js";
import { settle } from "../util/settle.js";
import { displayLine, plural } from "../util/text.js";
import { toIsoDate } from "../util/time.js";
import { VERSION } from "../version.js";

// Feed titles and error messages come from outside; one long one should not flood the report.
const DETAIL_MAX_CHARS = 200;

// Only whether each is set is shown, never the value. Typed against the lists they are read
// by, so a renamed variable cannot leave a stale name here.
const ENV_NAMES: readonly (SecretEnvName | ConfigEnvName | typeof STATE_PATH_ENV | "ANTHROPIC_BASE_URL")[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "TAVILY_API_KEY",
  "SLACK_WEBHOOK_URL",
  "GITHUB_TOKEN",
  ...CONFIG_ENV_NAMES,
  STATE_PATH_ENV,
];
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
  /** Where secrets and POCHI_* overrides come from; process.env when left out. */
  env?: NodeJS.ProcessEnv;
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
  // Colored only on the real stdout; a write passed in gets the plain report.
  const { signal } = deps;
  const env = deps.env ?? process.env;
  const report = new Report((line) => write(redact(line)), deps.write === undefined && isFancy(process.stdout, env));
  report.title(report.fancy ? `${purple("pochi")} ${VERSION} doctor` : `pochi ${VERSION} doctor`);
  const interrupted = () => ({ checks: report.checks, exitCode: ExitCode.INTERRUPTED });
  try {
    const config = await checkConfig(report, opts.configDir, env);
    signal?.throwIfAborted();
    // Read while the LLM probe (up to 10 seconds) runs; it is still reported after it. Settled,
    // so a failure is never an unhandled rejection meanwhile.
    const statePath = resolveStatePath({ flag: opts.state, env });
    const stateRead = settle(inspectState(statePath));
    await checkLlm(report, config, deps, env);
    signal?.throwIfAborted();
    checkEnv(report, env);
    await checkNotify(report, config, env);
    await checkState(report, config, statePath, stateRead, deps.now ?? new Date());
    signal?.throwIfAborted();
    if (opts.fetch) await checkSources(report, config, signal, env);
  } catch (err) {
    if (signal?.aborted) return interrupted();
    throw err;
  }
  // A step that does not watch the signal may have finished after an abort.
  if (signal?.aborted) return interrupted();
  return { checks: report.checks, exitCode: report.summary() };
}

async function checkConfig(
  report: Report,
  configDir: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<LoadedConfig | undefined> {
  let config: LoadedConfig;
  try {
    config = await loadConfig({ configDir, env });
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
  if (queries > 0 && !tavilyApiKey(env)) {
    // Same check as run: with no feeds, nothing would be fetched at all.
    if (sources.feeds.length === 0) {
      report.fail("Config", "queries", "no feeds, and the queries need TAVILY_API_KEY", ExitCode.CONFIG);
    } else {
      report.warn("Config", "queries", `${plural(queries, "query", "queries")} skipped without TAVILY_API_KEY`);
    }
  }
  return config;
}

async function checkLlm(
  report: Report,
  config: LoadedConfig | undefined,
  deps: DoctorDeps,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!config) {
    report.skip("LLM", "llm", "config is invalid");
    return;
  }
  try {
    const { client, models, cliVersion } = await resolveLlm(config.context.llm, {
      env,
      platform: deps.platform,
      spawn: deps.spawn,
      command: deps.command,
      signal: deps.signal,
    });
    // The same check a run makes before fetching: a revoked key, a mistyped API model or a
    // logged-out CLI. It uses no tokens; what it cannot tell (no network, a 5xx) passes.
    await client.preflight?.({ signal: deps.signal });
    // Without a configured model, codex uses the one its login defaults to.
    const tiers = `triage ${models.triage ?? "codex default"} · analyze ${models.analyze ?? "codex default"}`;
    if (client.mode === "cli") {
      report.ok("LLM", `cli mode (${client.backend})`, `${cliVersion} · ${tiers}`);
    } else {
      report.ok("LLM", "api mode", `${tiers} (key and models checked, no tokens used)`);
    }
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    report.fail("LLM", "llm", `${err.kind}: ${err.message}`, ExitCode.LLM);
  }
}

function checkEnv(report: Report, env: NodeJS.ProcessEnv): void {
  for (const name of ENV_NAMES) {
    const raw = env[name];
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

async function checkNotify(report: Report, config: LoadedConfig | undefined, env: NodeJS.ProcessEnv): Promise<void> {
  if (!config) {
    report.skip("Notify", "channels", "config is invalid");
    return;
  }
  for (const channel of config.context.notify.channels) {
    switch (channel.type) {
      case "slack": {
        const webhook = slackWebhookUrl(env);
        // run stops with 2 before fetching (createNotifiers); --dry-run delivers nothing and does not need it.
        if (!webhook) {
          report.fail("Notify", "slack", "SLACK_WEBHOOK_URL is not set (run --dry-run does not need it)", ExitCode.CONFIG);
        } else if (!webhook.startsWith(SLACK_WEBHOOK_PREFIX)) {
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
      if (isEnoent(err) && dirname(path) !== path) continue;
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

async function checkState(
  report: Report,
  config: LoadedConfig | undefined,
  path: string,
  pending: Promise<PromiseSettledResult<StateInspection>>,
  now: Date,
): Promise<void> {
  const read = await pending;
  if (read.status === "rejected") {
    const err = read.reason;
    if (!(err instanceof StateError)) throw err;
    report.fail("State", path, withCause(err.message, err.cause), ExitCode.INTERNAL);
    return;
  }
  const found = read.value;
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
  const counts: Record<EntryStatus, number> = { n: 0, i: 0, r: 0, u: 0 };
  for (const entry of entries.values()) counts[entry.s]++;
  let detail = `${plural(entries.size, "entry", "entries")} (n ${counts.n} · i ${counts.i} · r ${counts.r} · u ${counts.u})`;
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
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!config) {
    report.skip("Sources", "sources", "config is invalid");
    return;
  }
  const { sources } = config;
  const withQueries = tavilyApiKey(env) !== undefined;
  const configs = sourceConfigs(sources, withQueries);
  const outcomes = await fetchEach(configs, { ...sources.defaults, env }, { signal });
  if (signal && outcomes.some((o) => o.kind === "aborted")) throw signal.reason;
  for (const outcome of outcomes) {
    const label = sourceLabel(outcome.source);
    switch (outcome.kind) {
      case "error":
        report.fail("Sources", label, errorText(outcome.error));
        break;
      case "items": {
        const title = outcome.items[0]?.title;
        if (title === undefined) report.warn("Sources", label, "no items");
        else report.ok("Sources", label, title);
        break;
      }
      case "aborted":
        // Only without a signal to rethrow, where nothing can abort; nothing to report.
        break;
    }
  }
  if (!withQueries) {
    for (const q of sources.queries) report.skip("Sources", `${q.id} (tavily)`, "TAVILY_API_KEY is not set");
  }
  // Like run: some failing sources is fine, all of them is not.
  if (configs.length > 0 && outcomes.every((o) => o.kind === "error")) {
    report.fail("Sources", "sources", `all ${plural(configs.length, "source")} failed`, ExitCode.SOURCES);
  }
}

const STATUS_STYLE: Record<CheckStatus, "green" | "yellow" | "red" | "dim"> = {
  ok: "green",
  warn: "yellow",
  fail: "red",
  skip: "dim",
  "-": "dim",
};

const LABEL_WIDTH = 20;

class Report {
  readonly checks: Check[] = [];
  private section: Section | undefined;

  constructor(
    private readonly out: (line: string) => void,
    readonly fancy = false,
  ) {}

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
    this.out(counts.join(", ") + (this.fancy && failed.length === 0 ? `. ${purple("Pochi is ready to fetch.")}` : ""));
    return failed[0]?.exitCode ?? ExitCode.OK;
  }

  private add(check: Check): void {
    if (check.section !== this.section) {
      this.section = check.section;
      const heading = check.section === "Sources" ? "Sources (--fetch)" : check.section;
      this.out(this.fancy ? styleText("bold", heading) : heading);
    }
    this.checks.push(check);
    // A multi-line detail (a ConfigError's issues) continues under the detail column, and so does
    // the detail of a label too long for its column (a long source id with its kind).
    const label = oneLine(check.label);
    const details = check.detail.split("\n").map(oneLine);
    if (label.length > LABEL_WIDTH) details.unshift("");
    const [first = "", ...rest] = details;
    const status = check.status.padEnd(5);
    this.out(`  ${this.fancy ? styleText(STATUS_STYLE[check.status], status) : status} ${label.padEnd(LABEL_WIDTH)} ${first}`.trimEnd());
    for (const line of rest) this.out(`  ${"".padEnd(5)} ${"".padEnd(LABEL_WIDTH)} ${line}`);
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
