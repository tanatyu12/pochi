import { ConfigError } from "../config/load.js";
import { toCron } from "./calendar.js";
import type { ExecFn } from "./exec.js";
import type { Job, Scheduler } from "./types.js";

/**
 * A line in the user's crontab, found again by the marker comment at its end. Lines without the
 * marker are never touched. cron does not catch up on runs missed while the machine was off.
 */
export function cronScheduler(deps: { exec: ExecFn }): Scheduler {
  const marker = (job: Job) => `# pochi:${job.id}`;
  const isOurs = (line: string, job: Job) => line.trimEnd().endsWith(marker(job));
  return {
    name: "cron",
    zone: "local",
    location: () => "crontab",
    render(job, cal) {
      for (const s of [job.cwd, job.path, job.logPath, ...job.argv]) {
        // A crontab entry is one line; the rest of the job would run as a separate command.
        if (/[\n\r]/.test(s)) throw new ConfigError(`cannot put a path with a line break in a crontab: ${s}`);
      }
      const command = [
        `cd ${quote(job.cwd)} &&`,
        `PATH=${quote(job.path)}`,
        ...job.argv.map(quote),
        `>> ${quote(job.logPath)} 2>&1`,
      ].join(" ");
      return `${toCron(cal)} ${command} ${marker(job)}`;
    },
    async install(job, content) {
      const others = (await readCrontab(deps.exec)).filter((line) => !isOurs(line, job));
      await writeCrontab(deps.exec, [...others, content]);
      return ["cron does not run jobs missed while the machine is off or asleep."];
    },
    async uninstall(job) {
      const lines = await readCrontab(deps.exec);
      const others = lines.filter((line) => !isOurs(line, job));
      if (others.length === lines.length) return false;
      await writeCrontab(deps.exec, others);
      return true;
    },
    async inspect(job) {
      return { content: (await readCrontab(deps.exec)).find((line) => isOurs(line, job)) };
    },
  };
}

/** Lines of the current crontab; none when the user has no crontab yet. */
async function readCrontab(exec: ExecFn): Promise<string[]> {
  const r = await exec("crontab", ["-l"]);
  if (r.code !== 0) {
    if (/no crontab/i.test(r.stderr)) return [];
    throw new ConfigError(`crontab -l failed (${r.code}): ${r.stderr.trim()}`);
  }
  const lines = r.stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function writeCrontab(exec: ExecFn, lines: string[]): Promise<void> {
  // cron ignores a last line without a newline.
  const r = await exec("crontab", ["-"], { input: lines.map((l) => `${l}\n`).join("") });
  if (r.code !== 0) throw new ConfigError(`crontab - failed (${r.code}): ${r.stderr.trim()}`);
}

/** Single quotes for the shell; cron turns an unescaped % into a newline, so it is escaped too. */
function quote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`.replaceAll("%", "\\%");
}
