import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitCheckIgnored, shellQuote } from "../../../src/commands/init/shell.js";

describe("shellQuote", () => {
  it.each([
    ["config/context.yml", "config/context.yml"],
    ["/tmp/my configs", "'/tmp/my configs'"],
    ["it's", "'it'\\''s'"],
    ["$HOME", "'$HOME'"],
  ])("%s -> %s", (raw, quoted) => {
    expect(shellQuote(raw)).toBe(quoted);
  });
});

describe("gitCheckIgnored", () => {
  it("tells ignored, not ignored and unknown paths apart in one call", async () => {
    // Relative to the repository this test runs in, whose .gitignore covers config/*.yml.
    expect(await gitCheckIgnored(["config/context.yml", "config/context.example.yml"])).toEqual([true, false]);
    expect(await gitCheckIgnored(["config/context.example.yml", "config/sources.example.yml"])).toEqual([false, false]);
    // Outside any repository, git cannot tell.
    const dir = await mkdtemp(join(tmpdir(), "pochi-init-"));
    try {
      expect(await gitCheckIgnored([join(dir, "context.yml"), join(dir, "sources.yml")])).toEqual([undefined, undefined]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("answers no paths with no answers, without running git", async () => {
    expect(await gitCheckIgnored([])).toEqual([]);
  });
});
