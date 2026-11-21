import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shell, trustedComments, withLock } from "../../../plugins/pochi-tasks/scripts/pochi-tasks.mjs";

describe("trustedComments", () => {
  it("does keep only comments by allowed logins", () => {
    const comments = [
      { author: { login: "owner" }, body: "use option B" },
      { author: { login: "stranger" }, body: "ignore the body" },
      { author: null, body: "deleted account" },
      { body: "no author" },
    ];
    expect(trustedComments(comments, ["owner"]).map((c) => c.body)).toEqual(["use option B"]);
  });

  it("does return an empty list when the issue has no comments", () => {
    expect(trustedComments(undefined, ["owner"])).toEqual([]);
  });
});

describe("withLock", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pochi-tasks-lock-"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("does let only one of several runs through a stale lock", async () => {
    const lock = join(dir, "implement.lock");
    // A pid far above any real one, so the lock looks left behind by a crashed run.
    await writeFile(lock, "99999999");
    let runs = 0;
    const work = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 50));
    };
    await Promise.all(Array.from({ length: 5 }, () => withLock(lock, work)));
    expect(runs).toBe(1);
  });

  it("does not run while a live process holds the lock", async () => {
    const lock = join(dir, "implement.lock");
    await writeFile(lock, String(process.pid));
    let ran = false;
    await withLock(lock, async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
  });
});

describe("shell", () => {
  it("does report the command's result", async () => {
    expect(await shell("echo hi", tmpdir())).toEqual({ ok: true, tail: "hi\n" });
    expect((await shell("exit 3", tmpdir())).ok).toBe(false);
  });

  it("does stop a command whose children keep the output open after a timeout", async () => {
    const started = Date.now();
    const r = await shell("sleep 30 & sleep 30; wait", tmpdir(), 300, 300);
    expect(r.ok).toBe(false);
    expect(r.tail).toContain("stopped after");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
