import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCron } from "../../src/schedule/calendar.js";
import { buildJob } from "../../src/schedule/index.js";
import { launchdScheduler, startCalendarInterval } from "../../src/schedule/launchd.js";
import { fakeExec } from "../helpers/fakeExec.js";

let home: string;
const job = buildJob({
  cwd: "/work/my <app>",
  scriptPath: "/work/my <app>/dist/pochi.mjs",
  execPath: "/opt/node/bin/node",
  path: "/opt/node/bin:/usr/bin",
});
const plistPath = () => join(home, "Library", "LaunchAgents", `${job.id}.plist`);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pochi-launchd-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("startCalendarInterval", () => {
  it("makes one dictionary per combination of the restricted fields", () => {
    expect(startCalendarInterval(parseCron("17 6 * * 1,4"))).toEqual([
      [["Weekday", 1], ["Hour", 6], ["Minute", 17]],
      [["Weekday", 4], ["Hour", 6], ["Minute", 17]],
    ]);
    expect(startCalendarInterval(parseCron("0 9 1 */6 *"))).toEqual([
      [["Month", 1], ["Day", 1], ["Hour", 9], ["Minute", 0]],
      [["Month", 7], ["Day", 1], ["Hour", 9], ["Minute", 0]],
    ]);
    expect(startCalendarInterval(parseCron("* * * * *"))).toEqual([[]]);
  });

  it("refuses day of month with weekday, and too many combinations", () => {
    expect(() => startCalendarInterval(parseCron("0 6 1 * 1"))).toThrow("day of the month or a weekday");
    expect(() => startCalendarInterval(parseCron("*/5 9-17 * * *"))).toThrow("more than 100 launchd intervals");
  });
});

describe("launchdScheduler", () => {
  it("renders a LaunchAgent with escaped strings", () => {
    const scheduler = launchdScheduler({ exec: fakeExec().exec, home, uid: 501 });
    expect(scheduler.render(job, parseCron("17 6 * * 1,4"), "weekly -- on Monday and Thursday")).toMatchSnapshot();
  });

  it("keeps any run of dashes in the summary from ending or breaking the XML comment", () => {
    const scheduler = launchdScheduler({ exec: fakeExec().exec, home, uid: 501 });
    for (const summary of ["a---b", "ends with-", "--"]) {
      const plist = scheduler.render(job, parseCron("17 6 * * *"), summary);
      const inner = /<!-- (.*) -->/.exec(plist)?.[1];
      expect(inner).toBeDefined();
      expect(inner).not.toContain("--");
      expect(inner).not.toMatch(/-$/);
    }
  });

  it("boots out the old job, writes the plist and bootstraps it", async () => {
    const { exec, calls } = fakeExec((c) => (c.args[0] === "bootout" ? { code: 3 } : undefined));
    const scheduler = launchdScheduler({ exec, home, uid: 501 });
    const notes = await scheduler.install(job, "<plist/>");
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ["launchctl", "bootout", `gui/501/${job.id}`],
      ["launchctl", "bootstrap", "gui/501", plistPath()],
    ]);
    expect(await readFile(plistPath(), "utf8")).toBe("<plist/>");
    expect((await stat(plistPath())).mode & 0o777).toBe(0o644);
    expect(notes[0]).toContain("asleep");
  });

  it("retries a bootstrap once, then fails with launchctl's message", async () => {
    let bootstraps = 0;
    const flaky = fakeExec((c) => (c.args[0] === "bootstrap" && bootstraps++ === 0 ? { code: 5 } : undefined));
    await launchdScheduler({ exec: flaky.exec, home, uid: 501, retryDelayMs: 0 }).install(job, "<plist/>");
    expect(bootstraps).toBe(2);

    const broken = fakeExec((c) =>
      c.args[0] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error\n" } : undefined,
    );
    await expect(
      launchdScheduler({ exec: broken.exec, home, uid: 501, retryDelayMs: 0 }).install(job, "<plist/>"),
    ).rejects.toThrow("launchctl bootstrap failed (5): Bootstrap failed: 5: Input/output error");
  });

  it("uninstalls and inspects", async () => {
    let loaded = true;
    const { exec } = fakeExec((c) => {
      if (c.args[0] === "bootout") {
        const was = loaded;
        loaded = false;
        return { code: was ? 0 : 3 };
      }
      if (c.args[0] === "bootstrap") loaded = true;
      return c.args[0] === "print" ? { code: loaded ? 0 : 113 } : undefined;
    });
    const scheduler = launchdScheduler({ exec, home, uid: 501 });
    expect(await scheduler.inspect(job)).toEqual({ content: undefined, loaded: true });
    await scheduler.install(job, "<plist/>");
    expect(await scheduler.inspect(job)).toEqual({ content: "<plist/>", loaded: true });
    expect(await scheduler.uninstall(job)).toBe(true);
    expect(await scheduler.inspect(job)).toEqual({ content: undefined, loaded: false });
    expect(await scheduler.uninstall(job)).toBe(false);
  });
});
