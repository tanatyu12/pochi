import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installSchedule,
  type ScheduleDeps,
  scheduleCommand,
  scheduleStatus,
  uninstallSchedule,
} from "../../src/commands/schedule.js";
import { ExitCode } from "../../src/errors.js";
import { fakeCrontab, fakeExec } from "../helpers/fakeExec.js";

const NOW = new Date("2026-10-28T03:00:00Z"); // Wed 12:00 in Tokyo
const SOURCES = `version: 1
feeds:
  - { id: blog, type: rss, name: Blog, url: "https://example.com/feed" }
`;

let cwd: string;
let home: string;
let out: string[];

function context(extra = ""): string {
  return `version: 1
project: { name: app, description: "" }
problems: [p]
${extra}`;
}

async function setup(contextYaml: string): Promise<void> {
  await mkdir(join(cwd, "config"), { recursive: true });
  await writeFile(join(cwd, "config", "context.yml"), contextYaml);
  await writeFile(join(cwd, "config", "sources.yml"), SOURCES);
}

function deps(overrides: Partial<ScheduleDeps> = {}): ScheduleDeps {
  return {
    platform: "darwin",
    cwd,
    home,
    uid: 501,
    scriptPath: join(cwd, "dist", "pochi.mjs"),
    execPath: "/usr/bin/node",
    env: { PATH: "/usr/bin" },
    now: () => NOW,
    timeZone: "Asia/Tokyo",
    exec: fakeExec().exec,
    write: (line) => out.push(line),
    ...overrides,
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pochi-schedule-"));
  home = await mkdtemp(join(tmpdir(), "pochi-home-"));
  out = [];
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("schedule install", () => {
  it("prints the schedule and the plist with --print, and changes nothing", async () => {
    await setup(context('schedule: { interval: weekly, day: [monday, thursday], timezone: Asia/Tokyo }\n'));
    const { exec, calls } = fakeExec();
    await installSchedule({ print: true }, deps({ exec }));
    expect(out.slice(0, 3)).toEqual([
      "Schedule: weekly on Monday and Thursday at 06:17 (Asia/Tokyo)",
      "launchd: 17 6 * * 1,4 (Asia/Tokyo)",
      "Next runs: Thu 2026-10-29 06:17, Mon 2026-11-02 06:17, Thu 2026-11-05 06:17",
    ]);
    expect(out.join("\n")).toContain("<key>Weekday</key><integer>4</integer>");
    expect(calls).toEqual([]);
    await expect(stat(join(cwd, "logs"))).rejects.toThrow();
  });

  it("installs the LaunchAgent, creates logs/ and warns about a missing .env", async () => {
    await setup(context());
    const { exec, calls } = fakeExec();
    await installSchedule({}, deps({ exec }));
    expect(out).toContain("warn: no .env, and scheduled runs need SLACK_WEBHOOK_URL from it");
    expect(out.some((l) => /^Installed launchd job sh\.pochi\.\w{8}: .*\.plist$/.test(l))).toBe(true);
    expect(out).toContain("Log: logs/pochi.log");
    expect(calls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap"]);
    expect((await stat(join(cwd, "logs"))).isDirectory()).toBe(true);
  });

  it("checks the keys and mode of .env without printing values", async () => {
    await setup(context("llm: { provider: api }\n"));
    await writeFile(join(cwd, ".env"), "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T/B/secretvalue\n");
    await chmod(join(cwd, ".env"), 0o644);
    await installSchedule({}, deps());
    const warnings = out.filter((l) => l.startsWith("warn:"));
    expect(warnings).toEqual([
      "warn: .env can be read by other users; run chmod 600 .env",
      "warn: .env has no ANTHROPIC_API_KEY; scheduled runs read keys from it only",
    ]);
    expect(out.join("\n")).not.toContain("secretvalue");

    out = [];
    await writeFile(join(cwd, ".env"), "SLACK_WEBHOOK_URL=x\nANTHROPIC_API_KEY=y\n");
    await chmod(join(cwd, ".env"), 0o600);
    await installSchedule({}, deps());
    expect(out.filter((l) => l.startsWith("warn:"))).toEqual([]);
  });

  it("installs a dry-run job at another time, which needs no webhook", async () => {
    await setup(context());
    await installSchedule({ at: "12:05", dryRun: true, print: true }, deps());
    expect(out[0]).toBe("Schedule: daily at 12:05 (Asia/Tokyo)");
    expect(out.join("\n")).toContain("<string>--dry-run</string>");

    out = [];
    await installSchedule({ dryRun: true }, deps());
    expect(out.filter((l) => l.startsWith("warn:"))).toEqual([]);
  });

  it("rejects a bad --at, and --at with a cronjob", async () => {
    await setup(context());
    await expect(installSchedule({ at: "25:00" }, deps())).rejects.toMatchObject({
      exitCode: ExitCode.CONFIG,
      message: '"25:00" is not a time (use HH:MM, 24-hour)',
    });
    await setup(context('schedule: { interval: cron, cronjob: "0 8 * * 1-5" }\n'));
    await expect(installSchedule({ at: "09:00" }, deps())).rejects.toThrow("--at cannot be used with interval: cron");
  });

  it("writes the workflow in UTC for github", async () => {
    await setup(context("schedule: { timezone: Asia/Tokyo }\nnotify: { channels: [{ type: file }] }\n"));
    await installSchedule({ backend: "github" }, deps());
    expect(out[1]).toBe("github: 17 21 * * * (UTC)");
    expect(out).toContain("warn: the file channel writes on the Actions runner, where the files are lost after the run");
    const workflow = await readFile(join(cwd, ".github/workflows/daily_briefing.yml"), "utf8");
    expect(workflow).toContain('- cron: "17 21 * * *"');
    expect(workflow).toContain("# daily at 06:17 (Asia/Tokyo)");
  });

  it("warns for github when llm.provider names a CLI, which the runner does not have", async () => {
    await setup(context("llm: { provider: codex }\n"));
    await installSchedule({ backend: "github" }, deps());
    expect(out).toContain("warn: llm.provider is codex, but the Actions runner has no CLI to run; use auto or api there");
  });

  it("reads the time as UTC for github when no timezone is set, and says so", async () => {
    await setup(context());
    await installSchedule({ backend: "github", print: true }, deps());
    expect(out[1]).toBe("github: 17 6 * * * (UTC)");
    expect(out).toContain(
      "warn: schedule.timezone is not set, so the time is read as UTC; set it to run on Asia/Tokyo time",
    );
  });

  it("refuses a schedule the backend cannot express", async () => {
    await setup(context("schedule: { interval: monthly, timezone: Asia/Tokyo }\n"));
    await expect(installSchedule({ backend: "github" }, deps())).rejects.toMatchObject({
      exitCode: ExitCode.CONFIG,
      message: expect.stringContaining("set schedule.timezone to UTC"),
    });
    await setup(context('schedule: { interval: cron, cronjob: "0 6 1 * 1" }\n'));
    await expect(installSchedule({}, deps())).rejects.toThrow("launchd cannot run on a day of the month or a weekday");
  });

  it("refuses an invalid config, a run through tsx and an unknown backend", async () => {
    await setup(context("schedule: { interval: hourly }\n"));
    await expect(installSchedule({}, deps())).rejects.toMatchObject({ exitCode: ExitCode.CONFIG });
    await setup(context());
    await expect(installSchedule({}, deps({ scriptPath: join(cwd, "src", "cli.ts") }))).rejects.toThrow(
      "npm run build",
    );
    await expect(installSchedule({ backend: "systemd" }, deps())).rejects.toThrow('unknown backend "systemd"');
  });

  it("uses cron on Linux and has no local backend on Windows yet", async () => {
    await setup(context());
    const crontab = fakeCrontab();
    await installSchedule({}, deps({ platform: "linux", exec: crontab.exec }));
    expect(crontab.text()).toMatch(/^17 6 \* \* \* cd '.+' && .+ # pochi:sh\.pochi\.\w{8}\n$/);
    await expect(installSchedule({}, deps({ platform: "win32" }))).rejects.toThrow(
      "no local scheduler for win32 yet; use --backend github",
    );
  });
});

describe("schedule status and uninstall", () => {
  it("reports a job that is not installed", async () => {
    await setup(context());
    await scheduleStatus({}, deps({ exec: fakeExec(() => ({ code: 113 })).exec }));
    expect(out).toEqual(["launchd: not installed (run `pochi schedule install`)"]);
  });

  it("takes the default config dir given by name or by path as no --config-dir", async () => {
    await setup(context());
    const crontab = fakeCrontab();
    const linux = deps({ platform: "linux", exec: crontab.exec });
    // As init installs it: with the dir it wrote to, here the default one.
    await installSchedule({ configDir: join(cwd, "config") }, linux);
    expect(crontab.text()).not.toContain("--config-dir");

    for (const configDir of [undefined, "config"]) {
      out = [];
      await scheduleStatus({ configDir }, linux);
      expect(out.some((line) => line.includes("differs"))).toBe(false);
    }
  });

  it("compares the installed job with context.yml", async () => {
    await setup(context());
    const crontab = fakeCrontab();
    const linux = deps({ platform: "linux", exec: crontab.exec });
    await installSchedule({ dryRun: true }, linux);

    out = [];
    await scheduleStatus({}, linux);
    expect(out).toEqual([
      "cron: installed (crontab)",
      "Schedule: daily at 06:17 (Asia/Tokyo)",
      "cron: 17 6 * * * (Asia/Tokyo)",
      "Next runs: Thu 2026-10-29 06:17, Fri 2026-10-30 06:17, Sat 2026-10-31 06:17",
      "note: installed with --dry-run, so runs post nothing",
      "Log: logs/pochi.log",
    ]);

    await setup(context("schedule: { time: \"07:00\" }\n"));
    out = [];
    await scheduleStatus({}, linux);
    expect(out).toContain("warn: the installed job differs from context.yml; run `pochi schedule install` again");

    await setup(context("schedule: { interval: never }\n"));
    out = [];
    await scheduleStatus({}, linux);
    expect(out).toEqual([
      "cron: installed (crontab)",
      "warn: the config is invalid, so the installed job cannot be compared with it",
    ]);
  });

  it("removes the job, and says when there was none", async () => {
    await setup(context());
    const crontab = fakeCrontab("0 3 * * * backup\n");
    const linux = deps({ platform: "linux", exec: crontab.exec });
    await installSchedule({}, linux);
    out = [];
    await uninstallSchedule({}, linux);
    expect(out[0]).toMatch(/^Removed cron job sh\.pochi\.\w{8} \(crontab\)$/);
    expect(crontab.text()).toBe("0 3 * * * backup\n");
    out = [];
    await uninstallSchedule({}, linux);
    expect(out).toEqual([`No cron job for ${cwd}`]);
  });
});

describe("scheduleCommand", () => {
  it("parses the subcommands and their options", async () => {
    await setup(context());
    const cmd = scheduleCommand(deps());
    await cmd.parseAsync(["install", "--print", "--at", "08:30", "--backend", "cron"], { from: "user" });
    expect(out[0]).toBe("Schedule: daily at 08:30 (Asia/Tokyo)");
    expect(out[1]).toBe("cron: 30 8 * * * (Asia/Tokyo)");
  });
});
