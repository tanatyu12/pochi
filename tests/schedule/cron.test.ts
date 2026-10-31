import { describe, expect, it } from "vitest";
import { parseCron } from "../../src/schedule/calendar.js";
import { cronScheduler } from "../../src/schedule/cron.js";
import { buildJob } from "../../src/schedule/index.js";
import { fakeCrontab, fakeExec } from "../helpers/fakeExec.js";

const job = buildJob({
  cwd: "/home/me/it's 100%",
  scriptPath: "/home/me/it's 100%/dist/pochi.mjs",
  execPath: "/usr/bin/node",
  path: "/usr/local/bin:/usr/bin",
  dryRun: true,
});
const OTHER = "0 3 * * * /usr/bin/backup # nightly";

describe("cronScheduler", () => {
  it("renders one line with quoted paths, escaped % and the marker", () => {
    expect(cronScheduler({ exec: fakeExec().exec }).render(job, parseCron("17 6 * * 1-5"), "")).toMatchSnapshot();
  });

  it("refuses a path with a line break", () => {
    const bad = { ...job, cwd: "/tmp/a\nb" };
    expect(() => cronScheduler({ exec: fakeExec().exec }).render(bad, parseCron("0 6 * * *"), "")).toThrow(
      "line break",
    );
  });

  it("adds the line to a missing crontab and replaces it later, keeping other lines", async () => {
    const crontab = fakeCrontab();
    const scheduler = cronScheduler({ exec: crontab.exec });
    await scheduler.install(job, `17 6 * * * run # pochi:${job.id}`);
    expect(crontab.text()).toBe(`17 6 * * * run # pochi:${job.id}\n`);

    const withOther = fakeCrontab(`${OTHER}\n17 6 * * * old # pochi:${job.id}\n`);
    const notes = await cronScheduler({ exec: withOther.exec }).install(job, `0 7 * * 1 new # pochi:${job.id}`);
    expect(withOther.text()).toBe(`${OTHER}\n0 7 * * 1 new # pochi:${job.id}\n`);
    expect(notes[0]).toContain("does not run jobs missed");
  });

  it("leaves another checkout's line alone", async () => {
    const theirs = "0 6 * * * other # pochi:sh.pochi.00000000";
    const crontab = fakeCrontab(`${theirs}\n`);
    const scheduler = cronScheduler({ exec: crontab.exec });
    await scheduler.install(job, `0 7 * * * mine # pochi:${job.id}`);
    expect(await scheduler.uninstall(job)).toBe(true);
    expect(crontab.text()).toBe(`${theirs}\n`);
    expect(await scheduler.inspect(job)).toEqual({ content: undefined });
  });

  it("does not rewrite the crontab when there is nothing to remove", async () => {
    const crontab = fakeCrontab(`${OTHER}\n`);
    expect(await cronScheduler({ exec: crontab.exec }).uninstall(job)).toBe(false);
    expect(crontab.calls.map((c) => c.args)).toEqual([["-l"]]);
  });

  it("fails on errors other than having no crontab", async () => {
    const { exec } = fakeExec(() => ({ code: 1, stderr: "crontab: you are not allowed to use this program\n" }));
    await expect(cronScheduler({ exec }).inspect(job)).rejects.toThrow(
      "crontab -l failed (1): crontab: you are not allowed to use this program",
    );
  });
});
