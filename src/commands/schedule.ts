import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Command } from "commander";
import { ConfigError, DEFAULT_CONFIG_DIR, type LoadedConfig, loadConfig } from "../config/load.js";
import type { Schedule } from "../config/schema.js";
import {
  type Calendar,
  CalendarError,
  calendarOf,
  convertZone,
  describeSchedule,
  nextRuns,
  offsetMinutes,
  parseTime,
  toCron,
  wallTime,
} from "../schedule/calendar.js";
import {
  type BackendName,
  buildJob,
  createScheduler,
  defaultBackend,
  ENV_FILE,
  type Job,
  parseBackend,
  type Scheduler,
  type SchedulerDeps,
} from "../schedule/index.js";
import { fsStep, unlessMissing } from "../schedule/fs.js";
import { redact } from "../util/log.js";

const NEXT_RUNS = 3;

export interface ScheduleOptions {
  backend?: string;
  configDir?: string;
}

export interface InstallOptions extends ScheduleOptions {
  /** Show what would be installed and change nothing. */
  print?: boolean;
  /** HH:MM in place of schedule.time, for this install only. */
  at?: string;
  /** The installed job runs `pochi run --dry-run`. */
  dryRun?: boolean;
}

/** Replaced in tests; the defaults are the real ones. */
export interface ScheduleDeps extends SchedulerDeps {
  platform?: NodeJS.Platform;
  cwd?: string;
  /** The bundle the job will call; defaults to the script running now. */
  scriptPath?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The machine's time zone. */
  timeZone?: string;
  /** Receives the output, one line at a time. Defaults to stdout. */
  write?: (line: string) => void;
}

interface Setup {
  scheduler: Scheduler;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  machineZone: string;
  write: (line: string) => void;
  job: (opts: { dryRun?: boolean }) => Job;
}

function setup(opts: ScheduleOptions, deps: ScheduleDeps): Setup {
  const backend: BackendName =
    opts.backend === undefined ? defaultBackend(deps.platform ?? process.platform) : parseBackend(opts.backend);
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  return {
    scheduler: createScheduler(backend, deps),
    cwd,
    env,
    now: deps.now?.() ?? new Date(),
    machineZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    write: (line) => write(redact(line)),
    job: ({ dryRun }) =>
      buildJob({
        cwd,
        scriptPath: deps.scriptPath ?? process.argv[1] ?? "",
        execPath: deps.execPath ?? process.execPath,
        path: env.PATH ?? "",
        configDir: opts.configDir,
        dryRun,
      }),
  };
}

/** The schedule on the backend's clock, and what to tell the user about the move. */
interface Planned {
  summary: string;
  calendar: Calendar;
  zone: string;
  warnings: string[];
}

function plan(schedule: Schedule, s: Setup): Planned {
  const isUtc = s.scheduler.zone === "UTC";
  const from = schedule.timezone ?? (isUtc ? "UTC" : s.machineZone);
  const zone = isUtc ? "UTC" : s.machineZone;
  const warnings: string[] = [];
  if (isUtc && schedule.timezone === undefined && offsetMinutes(s.machineZone, s.now) !== 0) {
    warnings.push(`schedule.timezone is not set, so the time is read as UTC; set it to run on ${s.machineZone} time`);
  }
  try {
    const converted = convertZone(calendarOf(schedule), from, zone, s.now);
    return {
      summary: describeSchedule(schedule, from),
      calendar: converted.calendar,
      zone,
      warnings: [...warnings, ...converted.warnings],
    };
  } catch (err) {
    throw asConfigError(err);
  }
}

function render(s: Setup, job: Job, p: Planned): string {
  try {
    return s.scheduler.render(job, p.calendar, p.summary);
  } catch (err) {
    throw asConfigError(err);
  }
}

/** Whether pochi runs from the built bundle: a scheduled run cannot go through tsx. */
export function runsFromBundle(deps: Pick<ScheduleDeps, "scriptPath"> = {}): boolean {
  return /\.m?js$/.test(deps.scriptPath ?? process.argv[1] ?? "");
}

export async function installSchedule(opts: InstallOptions, deps: ScheduleDeps = {}): Promise<void> {
  const s = setup(opts, deps);
  // The job calls the bundle that is running now.
  if (!runsFromBundle(deps)) {
    throw new ConfigError("run `npm run build` and install with `node dist/pochi.mjs schedule install`");
  }
  // A broken config would only show up at the first scheduled run.
  const config = await loadConfig({ configDir: resolve(s.cwd, opts.configDir ?? DEFAULT_CONFIG_DIR), env: s.env });
  let schedule = config.context.schedule;
  if (opts.at !== undefined) {
    if (schedule.interval === "cron") throw new ConfigError("--at cannot be used with interval: cron");
    try {
      parseTime(opts.at);
    } catch (err) {
      throw asConfigError(err);
    }
    schedule = { ...schedule, time: opts.at };
  }
  const p = plan(schedule, s);
  const job = s.job({ dryRun: opts.dryRun });
  const content = render(s, job, p);

  writeSummary(s, p);
  for (const w of p.warnings) s.write(`warn: ${w}`);
  if (opts.print) {
    s.write("");
    s.write(content.trimEnd());
    return;
  }
  const checks = s.scheduler.zone === "local" ? await checkEnvFile(s.cwd, config, opts.dryRun) : checkGithub(config);
  for (const w of checks) s.write(`warn: ${w}`);
  if (s.scheduler.zone === "local") {
    const logs = dirname(job.logPath);
    await fsStep("create", logs, () => mkdir(logs, { recursive: true }));
  }
  const notes = await s.scheduler.install(job, content);
  s.write(`Installed ${s.scheduler.name} job ${job.id}: ${display(s, s.scheduler.location(job))}`);
  if (s.scheduler.zone === "local") s.write(`Log: ${display(s, job.logPath)}`);
  for (const n of notes) s.write(n);
}

export async function uninstallSchedule(opts: ScheduleOptions, deps: ScheduleDeps = {}): Promise<void> {
  const s = setup(opts, deps);
  const job = s.job({});
  const removed = await s.scheduler.uninstall(job);
  s.write(
    removed
      ? `Removed ${s.scheduler.name} job ${job.id} (${display(s, s.scheduler.location(job))})`
      : `No ${s.scheduler.name} job for ${s.cwd}`,
  );
}

export async function scheduleStatus(opts: ScheduleOptions, deps: ScheduleDeps = {}): Promise<void> {
  const s = setup(opts, deps);
  const job = s.job({});
  const installed = await s.scheduler.inspect(job);
  if (installed.content === undefined) {
    s.write(`${s.scheduler.name}: not installed (run \`pochi schedule install\`)`);
    return;
  }
  const where = display(s, s.scheduler.location(job));
  s.write(`${s.scheduler.name}: ${installed.loaded === false ? "installed but not loaded" : "installed"} (${where})`);

  let config: LoadedConfig;
  try {
    config = await loadConfig({ configDir: resolve(s.cwd, opts.configDir ?? DEFAULT_CONFIG_DIR), env: s.env });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    s.write("warn: the config is invalid, so the installed job cannot be compared with it");
    return;
  }
  const p = plan(config.context.schedule, s);
  writeSummary(s, p);
  // Installed with --dry-run is still in step with the config; it is worth pointing out.
  const matches = [false, true].find((dryRun) => sameContent(installed.content, render(s, s.job({ dryRun }), p)));
  if (matches === undefined) {
    s.write("warn: the installed job differs from context.yml; run `pochi schedule install` again");
  } else if (matches) {
    s.write("note: installed with --dry-run, so runs post nothing");
  }
  if (s.scheduler.zone === "local") s.write(`Log: ${display(s, job.logPath)}`);
}

function writeSummary(s: Setup, p: Planned): void {
  s.write(`Schedule: ${p.summary}`);
  s.write(`${s.scheduler.name}: ${toCron(p.calendar)} (${p.zone})`);
  const runs = nextRuns(p.calendar, p.zone, s.now, NEXT_RUNS);
  s.write(`Next runs: ${runs.map((r) => wallTime(r, s.machineZone)).join(", ") || "none in the next 5 years"}`);
}

/** Warnings about the keys a local run reads from .env; values are never shown. */
async function checkEnvFile(cwd: string, config: LoadedConfig, dryRun?: boolean): Promise<string[]> {
  const path = join(cwd, ENV_FILE);
  const needed = [
    ...(!dryRun && config.context.notify.channels.some((c) => c.type === "slack") ? ["SLACK_WEBHOOK_URL"] : []),
    ...(config.context.llm.provider === "api" ? ["ANTHROPIC_API_KEY"] : []),
    ...(config.sources.queries.length > 0 ? ["TAVILY_API_KEY"] : []),
  ];
  const read = await unlessMissing("read", path, async () => ({ st: await stat(path), text: await readFile(path, "utf8") }));
  if (!read) return needed.length === 0 ? [] : [`no ${ENV_FILE}, and scheduled runs need ${needed.join(", ")} from it`];
  const vars = parseEnv(read.text);
  // Keys for Slack and Anthropic should not be readable by other users.
  if ((read.st.mode & 0o077) !== 0) {
    return [`${ENV_FILE} can be read by other users; run chmod 600 ${ENV_FILE}`, ...missing(needed, vars)];
  }
  return missing(needed, vars);
}

function missing(needed: string[], vars: Record<string, string | undefined>): string[] {
  const absent = needed.filter((name) => !vars[name]?.trim());
  return absent.length === 0 ? [] : [`${ENV_FILE} has no ${absent.join(", ")}; scheduled runs read keys from it only`];
}

function checkGithub(config: LoadedConfig): string[] {
  const { provider } = config.context.llm;
  return [
    ...(config.context.notify.channels.some((c) => c.type === "file")
      ? ["the file channel writes on the Actions runner, where the files are lost after the run"]
      : []),
    // The workflow sets ANTHROPIC_API_KEY; no CLI is installed or logged in on the runner.
    ...(provider !== "auto" && provider !== "api"
      ? [`llm.provider is ${provider}, but the Actions runner has no CLI to run; use auto or api there`]
      : []),
  ];
}

function display(s: Setup, path: string): string {
  if (path === "crontab") return path;
  const rel = relative(s.cwd, path);
  return rel.startsWith("..") ? path : rel;
}

// The plist was read from disk; a trailing newline lost along the way is not a difference.
function sameContent(a: string | undefined, b: string): boolean {
  return a?.trimEnd() === b.trimEnd();
}

function asConfigError(err: unknown): unknown {
  return err instanceof CalendarError ? new ConfigError(err.message) : err;
}

export function scheduleCommand(deps: ScheduleDeps = {}): Command {
  // Set before .command(): subcommands copy the parent's settings when they are created.
  const schedule = new Command("schedule")
    .description("Run pochi on the schedule in context.yml, with launchd, cron or GitHub Actions")
    .exitOverride();
  const backend = "launchd, cron or github (default: launchd on macOS, cron on Linux)";
  const configDir = "directory with context.yml and sources.yml";
  schedule
    .command("install")
    .description("Install or update the job for this checkout")
    .option("--backend <name>", backend)
    .option("--config-dir <dir>", configDir)
    .option("--print", "print what would be installed, and change nothing")
    .option("--at <HH:MM>", "run at this time instead of schedule.time")
    .option("--dry-run", "the scheduled runs print the briefing instead of posting it (to try the job)")
    .action((o: InstallOptions) => installSchedule(o, deps));
  schedule
    .command("uninstall")
    .description("Remove the job for this checkout")
    .option("--backend <name>", backend)
    .action((o: ScheduleOptions) => uninstallSchedule(o, deps));
  schedule
    .command("status")
    .description("Show whether the job is installed, when it runs next and whether it matches context.yml")
    .option("--backend <name>", backend)
    .option("--config-dir <dir>", configDir)
    .action((o: ScheduleOptions) => scheduleStatus(o, deps));
  return schedule;
}
