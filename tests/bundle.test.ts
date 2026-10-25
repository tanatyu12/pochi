import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const bundle = new URL("../dist/pochi.mjs", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// dist/ is rebuilt by tests/setup/build.ts before the suite runs.
describe("bundle", () => {
  it("prints the package version", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(bundle), "--version"]);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("starts with exactly one shebang", () => {
    const head = readFileSync(bundle, "utf8").split("\n").slice(0, 3);
    expect(head[0]).toBe("#!/usr/bin/env node");
    expect(head.filter((l) => l.startsWith("#!"))).toHaveLength(1);
  });
});
