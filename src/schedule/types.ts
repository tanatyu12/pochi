import type { Calendar } from "./calendar.js";

export type BackendName = "launchd" | "cron" | "github";

/** What a scheduled run executes. Everything is absolute: launchd and cron start elsewhere. */
export interface Job {
  /** sh.pochi.<hash of cwd>, so two checkouts on one machine get two jobs. */
  id: string;
  /** The checkout: config/, state/ and .env are read from here. */
  cwd: string;
  /** node, its flags, the bundle, then the run arguments. */
  argv: string[];
  /** launchd and cron start with a minimal PATH; the CLI mode needs the one claude is on. */
  path: string;
  /** stdout and stderr of every run are appended here. */
  logPath: string;
}

export interface Installed {
  /** The job as the backend holds it, when it holds one. */
  content?: string;
  /** Whether the backend has it loaded, for backends where that differs from the file existing. */
  loaded?: boolean;
}

/**
 * One way to run pochi on a schedule. The command converts the calendar to the backend's clock
 * (zone) first, then renders it; install takes what render returned, so --print shows exactly
 * what would be installed.
 */
export interface Scheduler {
  readonly name: BackendName;
  /** The clock the backend reads: the machine's, or UTC. */
  readonly zone: "local" | "UTC";
  /** Where the job lives, for messages: a file, or "crontab". */
  location(job: Job): string;
  /** summary describes the schedule in words, for a comment where the format allows one. */
  render(job: Job, cal: Calendar, summary: string): string;
  /** Replaces any job with the same id. Returns notes for the user. */
  install(job: Job, content: string): Promise<string[]>;
  /** False when there was nothing to remove. */
  uninstall(job: Job): Promise<boolean>;
  inspect(job: Job): Promise<Installed>;
}
