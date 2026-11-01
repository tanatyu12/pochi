import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/load.js";
import { ExitCode } from "../../src/errors.js";
import { fsFailure, fsStep, readIfExists, removeIfExists, unlessMissing } from "../../src/schedule/fs.js";

const errno = (code: string) => Object.assign(new Error(`${code}: secret detail`), { code });

describe("fsFailure", () => {
  it("does name the path and the code only, and keeps the error as the cause", () => {
    const cause = errno("EACCES");
    const err = fsFailure("write", "/home/u/x.plist", cause);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.exitCode).toBe(ExitCode.CONFIG);
    expect(err.message).toBe("could not write /home/u/x.plist (EACCES)");
    expect(err.cause).toBe(cause);
    expect(fsFailure("read", "/x", new Error("odd")).message).toBe("could not read /x");
  });
});

describe("fsStep", () => {
  it("does return the result, and turns a failure into a ConfigError", async () => {
    expect(await fsStep("read", "/x", async () => 1)).toBe(1);
    await expect(fsStep("read", "/x", () => Promise.reject(errno("EISDIR")))).rejects.toMatchObject({
      exitCode: ExitCode.CONFIG,
      message: "could not read /x (EISDIR)",
    });
  });
});

describe("unlessMissing", () => {
  it("does treat a missing file as undefined and anything else as a ConfigError", async () => {
    expect(await unlessMissing("read", "/x", () => Promise.reject(errno("ENOENT")))).toBeUndefined();
    await expect(unlessMissing("read", "/x", () => Promise.reject(errno("EACCES")))).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("readIfExists and removeIfExists", () => {
  it("does read and remove a file, and treat a missing one as nothing there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pochi-fs-"));
    try {
      const path = join(dir, "job.plist");
      expect(await readIfExists(path)).toBeUndefined();
      expect(await removeIfExists(path)).toBe(false);
      await writeFile(path, "content");
      expect(await readIfExists(path)).toBe("content");
      expect(await removeIfExists(path)).toBe(true);
      expect(await readIfExists(path)).toBeUndefined();
      // A directory is neither missing nor a file: a ConfigError naming it.
      await expect(readIfExists(dir)).rejects.toMatchObject({ exitCode: ExitCode.CONFIG, message: `could not read ${dir} (EISDIR)` });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
