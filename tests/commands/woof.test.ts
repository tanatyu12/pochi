import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";
import { woof } from "../../src/commands/woof.js";

let dir: string;
let out: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pochi-woof-"));
  out = "";
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (fancy: boolean) =>
  woof({ write: (s) => (out += s), fancy, statePath: join(dir, "notified.json"), wagMs: 0 });

describe("woof", () => {
  it("says how many briefings Pochi has fetched", async () => {
    await writeFile(join(dir, "notified.json"), JSON.stringify({ version: 1, briefings: 42, entries: {} }));
    await run(false);
    expect(out).toBe("Woof. 42 briefings fetched so far\n");
  });

  it("falls back to what Pochi does without a count", async () => {
    await run(false);
    expect(out).toBe("Woof. a daily briefing for your project\n");
  });

  it("redraws Pochi in place on a terminal, and shows the cursor again", async () => {
    await run(true);
    const frames = out.split(/\x1b\[\d+A\r/);
    expect(frames).toHaveLength(7);
    // Every frame is the same height, so moving up by it lands on the first one.
    const up = Number(/\x1b\[(\d+)A/.exec(out)![1]);
    for (const f of frames.slice(1)) expect(f.replace("\x1b[?25h", "").split("\n").length - 1).toBe(up);
    expect(out.endsWith("\x1b[?25h")).toBe(true);
  });

  it("is left out of --help", () => {
    expect(createProgram().helpInformation()).not.toContain("woof");
  });
});
