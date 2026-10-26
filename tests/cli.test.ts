import { describe, expect, it, vi } from "vitest";
import { createProgram, main } from "../src/cli.js";
import { VERSION } from "../src/version.js";

describe("cli", () => {
  it("has a doctor command", () => {
    expect(createProgram().commands.map((c) => c.name())).toContain("doctor");
  });

  it("prints the version with --version", async () => {
    let out = "";
    const program = createProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => (out += s) });
    await expect(program.parseAsync(["--version"], { from: "user" })).rejects.toMatchObject({
      code: "commander.version",
    });
    expect(out.trim()).toBe(VERSION);
  });

  it("returns 0 for --version and 2 for an unknown option", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["node", "pochi", "--version"])).toBe(0);
      expect(await main(["node", "pochi", "--no-such-option"])).toBe(2);
      // Subcommands report usage errors through main too, instead of exiting the process.
      expect(await main(["node", "pochi", "doctor", "--no-such-option"])).toBe(2);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
