import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/load.js";
import { ExitCode } from "../../src/errors.js";
import { createExec } from "../../src/schedule/exec.js";
import { fakeSpawn, run } from "../helpers/fakeSpawn.js";

describe("createExec", () => {
  it("does pass the input on stdin and return the exit code and output", async () => {
    const spawn = fakeSpawn(run.exit("out\n", { code: 3, stderr: "err\n" }));
    const result = await createExec(spawn.spawn)("crontab", ["-"], { input: "line\n" });
    expect(result).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
    expect(spawn.calls[0]?.command).toBe("crontab");
    expect(spawn.calls[0]?.args).toEqual(["-"]);
    expect(spawn.calls[0]?.stdin).toBe("line\n");
  });

  it("does turn a missing command into a ConfigError that names it", async () => {
    const pending = createExec(fakeSpawn(run.spawnError("ENOENT")).spawn)("launchctl", ["print"]);
    await expect(pending).rejects.toBeInstanceOf(ConfigError);
    await expect(pending).rejects.toMatchObject({ exitCode: ExitCode.CONFIG, message: "launchctl was not found on PATH" });
  });

  it("does pass on any other spawn failure as it is", async () => {
    const pending = createExec(fakeSpawn(run.spawnError("EACCES")).spawn)("crontab", ["-l"]);
    await expect(pending).rejects.toMatchObject({ code: "EACCES" });
    await expect(pending).rejects.not.toBeInstanceOf(ConfigError);
  });

  it("does ignore a stdin error from a command that exits without reading it", async () => {
    const spawn = fakeSpawn((child) => {
      process.nextTick(() => {
        child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        child.exit(0);
      });
    });
    await expect(createExec(spawn.spawn)("launchctl", ["bootout", "gui/501/x"])).resolves.toMatchObject({ code: 0 });
  });

  it("does report a process killed by a signal as exit code 1", async () => {
    const spawn = fakeSpawn((child) => process.nextTick(() => child.exit(null, "SIGTERM")));
    await expect(createExec(spawn.spawn)("crontab", ["-l"])).resolves.toMatchObject({ code: 1 });
  });
});
