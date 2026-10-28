import { randomBytes } from "node:crypto";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../util/log.js";
import { toMarkdown } from "./text.js";
import type { Briefing, Delivery, Notifier } from "./types.js";

/** A second run on the same day writes <date>-2.md and so on, up to this suffix. */
export const MAX_REPORTS_PER_DAY = 99;

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Writes the briefing to <dir>/<date>.md. An earlier report is never overwritten: its items are
 * already marked notified, so losing the file would lose them.
 */
export function fileNotifier(opts: { dir: string; postWhenEmpty: boolean }): Notifier {
  return {
    name: "file",
    async deliver(b: Briefing): Promise<Delivery> {
      const ids = b.insights.map((f) => f.item.id);
      if (ids.length === 0 && !opts.postWhenEmpty) return { deliveredIds: [], failures: [], aborted: false };
      try {
        const path = await writeNew(opts.dir, b.date, toMarkdown(b));
        log.info(`wrote ${path}`);
        return { deliveredIds: ids, failures: [], aborted: false };
      } catch (err) {
        log.warn(`the report was not written to ${opts.dir}`, err);
        return { deliveredIds: [], failures: [{ itemIds: ids, error: err }], aborted: false };
      }
    },
  };
}

// Written to a temporary file first, so a crash never leaves half a report under the real name;
// link then claims the first free name without replacing an existing one.
async function writeNew(dir: string, date: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${date}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let n = 1; n <= MAX_REPORTS_PER_DAY; n++) {
      const path = join(dir, n === 1 ? `${date}.md` : `${date}-${n}.md`);
      try {
        await link(tmp, path);
        return path;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        if (!LINK_UNSUPPORTED.has(code ?? "")) throw err;
      }
      // Without hard links (exFAT, some network drives), wx still never replaces a report; only
      // a crash mid-write can leave a partial one.
      try {
        await writeFile(path, content, { flag: "wx" });
        return path;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`${MAX_REPORTS_PER_DAY} reports for ${date} already exist`);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
