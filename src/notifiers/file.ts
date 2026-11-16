import { randomBytes } from "node:crypto";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReportFormat } from "../config/schema.js";
import { log } from "../util/log.js";
import { toReportJson } from "./json.js";
import { toMarkdown } from "./text.js";
import type { Briefing, Delivery, Notifier } from "./types.js";

/** A second run on the same day writes <date>-2.md and so on, up to this suffix. */
export const MAX_REPORTS_PER_DAY = 99;

const REPORT_MODE = 0o600;

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Writes the briefing to <dir>/<date>.md, and <date>.json when json is among the formats. An
 * earlier report is never overwritten: its items are already marked notified, so losing the file
 * would lose them.
 */
export function fileNotifier(opts: { dir: string; postWhenEmpty: boolean; formats?: readonly ReportFormat[] }): Notifier {
  const formats = opts.formats ?? ["md"];
  return {
    name: "file",
    async deliver(b: Briefing): Promise<Delivery> {
      const ids = b.insights.map((f) => f.item.id);
      if (ids.length === 0 && !opts.postWhenEmpty) return { deliveredIds: [], failures: [], aborted: false };
      try {
        const files = formats.map((f) => ({ ext: f, content: render(f, b) }));
        for (const path of await writeNew(opts.dir, b.date, files)) log.info(`wrote ${path}`);
        return { deliveredIds: ids, failures: [], aborted: false };
      } catch (err) {
        log.warn(`the report was not written to ${opts.dir}`, err);
        return { deliveredIds: [], failures: [{ itemIds: ids, error: err }], aborted: false };
      }
    },
  };
}

function render(format: ReportFormat, b: Briefing): string {
  switch (format) {
    case "md":
      return toMarkdown(b);
    case "json":
      return toReportJson(b);
  }
}

/**
 * Claims the first <date>[-n] name free for every format, so the files of one briefing always
 * share a name, and writes them all or none: a file linked before a later one fails is removed
 * again, since its insights are reported undelivered and will be written again. Each file goes to
 * a temporary file first, written and fsynced once, so a crash never leaves half a report under a
 * real name; link then claims names without replacing an existing one. Returns the paths written.
 */
async function writeNew(dir: string, date: string, files: readonly { ext: string; content: string }[]): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const tmps: string[] = [];
  try {
    for (const f of files) {
      const tmp = join(dir, `.${date}.${randomBytes(6).toString("hex")}.tmp`);
      tmps.push(tmp);
      // Owner-only, like the config files: a report says what a private project is working on.
      const fh = await open(tmp, "wx", REPORT_MODE);
      try {
        await fh.writeFile(f.content);
        await fh.sync();
      } finally {
        await fh.close();
      }
    }
    for (let n = 1; n <= MAX_REPORTS_PER_DAY; n++) {
      const base = join(dir, n === 1 ? date : `${date}-${n}`);
      const claimed: string[] = [];
      try {
        for (const [i, f] of files.entries()) {
          const path = `${base}.${f.ext}`;
          if (!(await claim(tmps[i]!, path, f.content))) break;
          claimed.push(path);
        }
      } catch (err) {
        await removeAll(claimed);
        throw err;
      }
      if (claimed.length === files.length) return claimed;
      // One of the names is taken: try the next n for all of them.
      await removeAll(claimed);
    }
    throw new Error(`${MAX_REPORTS_PER_DAY} reports for ${date} already exist`);
  } finally {
    await removeAll(tmps);
  }
}

/** Links tmp to path; false when path exists. */
async function claim(tmp: string, path: string, content: string): Promise<boolean> {
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (!LINK_UNSUPPORTED.has(code ?? "")) throw err;
  }
  // Without hard links (exFAT, some network drives), wx still never replaces a report; only a
  // crash mid-write can leave a partial one.
  try {
    await writeFile(path, content, { flag: "wx", mode: REPORT_MODE });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  }
}

async function removeAll(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {})));
}
