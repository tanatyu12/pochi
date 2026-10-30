import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/load.js";
import {
  BACKENDS,
  buildJob,
  createScheduler,
  defaultBackend,
  ENV_FILE,
  LOG_PATH,
  parseBackend,
} from "../../src/schedule/index.js";
import { fakeExec } from "../helpers/fakeExec.js";

const base = { cwd: "/work/app", scriptPath: "/work/app/dist/pochi.mjs", execPath: "/usr/bin/node", path: "/usr/bin:/bin" };

describe("buildJob", () => {
  it("does call the bundle with node, loading .env when it exists", () => {
    const job = buildJob(base);
    expect(job.cwd).toBe("/work/app");
    expect(job.argv).toEqual([
      "/usr/bin/node",
      `--env-file-if-exists=/work/app/${ENV_FILE}`,
      "/work/app/dist/pochi.mjs",
      "run",
    ]);
    expect(job.path).toBe("/usr/bin:/bin");
    expect(job.logPath).toBe(`/work/app/${LOG_PATH}`);
  });

  it("does derive the id from the checkout, so two checkouts get two jobs", () => {
    const id = buildJob(base).id;
    expect(id).toMatch(/^sh\.pochi\.[0-9a-f]{8}$/);
    expect(buildJob({ ...base, cwd: "/work/app/" }).id).toBe(id);
    expect(buildJob({ ...base, cwd: "/work/other" }).id).not.toBe(id);
  });

  it("does leave out the default config dir however it is given, and pass any other as absolute", () => {
    const plain = buildJob(base).argv;
    expect(buildJob({ ...base, configDir: "config" }).argv).toEqual(plain);
    expect(buildJob({ ...base, configDir: "/work/app/config" }).argv).toEqual(plain);
    expect(buildJob({ ...base, configDir: "conf/prod" }).argv.slice(3)).toEqual([
      "run",
      "--config-dir",
      "/work/app/conf/prod",
    ]);
  });

  it("does add --dry-run when asked", () => {
    expect(buildJob({ ...base, dryRun: true }).argv.slice(3)).toEqual(["run", "--dry-run"]);
  });
});

describe("defaultBackend", () => {
  it("does pick launchd on macOS and cron on Linux", () => {
    expect(defaultBackend("darwin")).toBe("launchd");
    expect(defaultBackend("linux")).toBe("cron");
  });

  it("does refuse other platforms with a ConfigError pointing at github", () => {
    expect(() => defaultBackend("win32")).toThrow(ConfigError);
    expect(() => defaultBackend("win32")).toThrow(/--backend github/);
  });
});

describe("parseBackend", () => {
  it("does accept each backend by name", () => {
    for (const name of BACKENDS) expect(parseBackend(name)).toBe(name);
  });

  it("does refuse an unknown name, listing the known ones", () => {
    expect(() => parseBackend("systemd")).toThrow(ConfigError);
    expect(() => parseBackend("systemd")).toThrow('unknown backend "systemd" (use launchd, cron, github)');
  });
});

describe("createScheduler", () => {
  it("does create each backend under its name", () => {
    const { exec } = fakeExec();
    for (const name of BACKENDS) expect(createScheduler(name, { exec, home: "/home/u", uid: 501 }).name).toBe(name);
  });
});
