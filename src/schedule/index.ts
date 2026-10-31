import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigError } from "../config/load.js";
import { sha256Hex } from "../util/hash.js";
import { cronScheduler } from "./cron.js";
import { type ExecFn, exec as defaultExec } from "./exec.js";
import { githubScheduler } from "./github.js";
import { launchdScheduler } from "./launchd.js";
import type { BackendName, Job, Scheduler } from "./types.js";

export const BACKENDS: readonly BackendName[] = ["launchd", "cron", "github"];
export const LOG_PATH = "logs/pochi.log";
export const ENV_FILE = ".env";

export interface SchedulerDeps {
  exec?: ExecFn;
  home?: string;
  uid?: number;
  retryDelayMs?: number;
}

export function createScheduler(name: BackendName, deps: SchedulerDeps = {}): Scheduler {
  const exec = deps.exec ?? defaultExec;
  switch (name) {
    case "launchd":
      return launchdScheduler({
        exec,
        home: deps.home ?? homedir(),
        uid: deps.uid ?? process.getuid?.() ?? 0,
        retryDelayMs: deps.retryDelayMs,
      });
    case "cron":
      return cronScheduler({ exec });
    case "github":
      return githubScheduler();
  }
}

/** The local backend for this machine. */
export function defaultBackend(platform: NodeJS.Platform): BackendName {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "cron";
  throw new ConfigError(`no local scheduler for ${platform} yet; use --backend github`);
}

export function parseBackend(name: string): BackendName {
  if ((BACKENDS as readonly string[]).includes(name)) return name as BackendName;
  throw new ConfigError(`unknown backend "${name}" (use ${BACKENDS.join(", ")})`);
}

/** The job for the checkout in cwd, calling the bundle at scriptPath. */
export function buildJob(opts: {
  cwd: string;
  scriptPath: string;
  execPath: string;
  path: string;
  configDir?: string;
  dryRun?: boolean;
}): Job {
  const cwd = resolve(opts.cwd);
  const args = [
    "run",
    ...(opts.configDir === undefined ? [] : ["--config-dir", resolve(cwd, opts.configDir)]),
    ...(opts.dryRun ? ["--dry-run"] : []),
  ];
  return {
    id: `sh.pochi.${sha256Hex(cwd).slice(0, 8)}`,
    cwd,
    // Missing .env is fine: the keys may be unneeded (CLI mode, file channel only).
    argv: [opts.execPath, `--env-file-if-exists=${join(cwd, ENV_FILE)}`, resolve(opts.scriptPath), ...args],
    path: opts.path,
    logPath: join(cwd, LOG_PATH),
  };
}

export type { BackendName, Job, Scheduler } from "./types.js";
