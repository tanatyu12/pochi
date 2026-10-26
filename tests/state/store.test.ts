import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureLog, resetLog } from "../../src/util/log.js";
import {
  DEFAULT_STATE_PATH,
  type State,
  type StateEntry,
  StateError,
  emptyState,
  isKnown,
  loadState,
  pruneState,
  record,
  resolveStatePath,
  saveState,
  statusOf,
  touch,
} from "../../src/state/store.js";

// Lets a test make the write of the staged file fail, to check that nothing is replaced, and the
// cleanup after it fail too, to check that the write error is the one reported.
const { fail, ENOSPC } = vi.hoisted(() => ({
  fail: { write: false, rm: false },
  ENOSPC: Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: (async (...args) => {
      const fh = await fs.open(...args);
      if (fail.write) {
        fh.writeFile = async () => {
          throw ENOSPC;
        };
      }
      return fh;
    }) as typeof fs.open,
    rm: (async (...args) => {
      if (fail.rm) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      return fs.rm(...args);
    }) as typeof fs.rm,
  };
});

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const NOW = new Date("2026-10-25T22:17:03.456Z");

function stateOf(entries: Record<string, StateEntry>): State {
  return { entries: new Map(Object.entries(entries)) };
}

let dir: string;
let path: string;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pochi-state-"));
  path = join(dir, "notified.json");
  logs = [];
  configureLog({ write: (s) => logs.push(s) });
});

afterEach(async () => {
  fail.write = false;
  fail.rm = false;
  resetLog();
  await rm(dir, { recursive: true, force: true });
});

describe("resolveStatePath", () => {
  it("prefers the flag, then POCHI_STATE_PATH, then the default", () => {
    const env = { POCHI_STATE_PATH: "env.json" };
    expect(resolveStatePath({ flag: "flag.json", env })).toBe("flag.json");
    expect(resolveStatePath({ env })).toBe("env.json");
    expect(resolveStatePath({ env: {} })).toBe(DEFAULT_STATE_PATH);
  });

  it("ignores a blank POCHI_STATE_PATH", () => {
    expect(resolveStatePath({ env: { POCHI_STATE_PATH: "  " } })).toBe(DEFAULT_STATE_PATH);
  });

  it.each(["", "  "])("treats a blank flag (%j) as unset", (flag) => {
    expect(resolveStatePath({ flag, env: { POCHI_STATE_PATH: "env.json" } })).toBe("env.json");
    expect(resolveStatePath({ flag, env: {} })).toBe(DEFAULT_STATE_PATH);
  });
});

describe("loadState", () => {
  it("starts empty when the file does not exist", async () => {
    const state = await loadState(path);
    expect(state.entries.size).toBe(0);
    expect(logs).toEqual([]);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["an unknown version", JSON.stringify({ version: 2, entries: {} })],
    ["entries that are not an object", JSON.stringify({ version: 1, entries: [] })],
    ["JSON that is not an object", "null"],
  ])("moves aside %s and starts empty", async (_, content) => {
    await writeFile(path, content);
    const state = await loadState(path, { now: NOW });
    expect(state.entries.size).toBe(0);
    const files = await readdir(dir);
    expect(files).toEqual([expect.stringMatching(/^notified\.json\.corrupt-20261025T221703Z-[0-9a-f]{6}$/)]);
    expect(await readFile(join(dir, files[0]!), "utf8")).toBe(content);
    expect(logs.join("")).toContain("moved it to");
  });

  it("reads pending entries (r)", async () => {
    const pending = { s: "r", f: "2026-10-24", l: "2026-10-25" };
    await writeFile(path, JSON.stringify({ version: 1, updatedAt: "2026-10-25T00:00:00Z", entries: { [A]: pending } }));
    expect([...(await loadState(path)).entries]).toEqual([[A, pending]]);
  });

  it("keeps both backups when the file is corrupt twice within a second", async () => {
    await writeFile(path, "first");
    await loadState(path, { now: NOW });
    await writeFile(path, "second");
    await loadState(path, { now: NOW });
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    const contents = await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")));
    expect(contents.sort()).toEqual(["first", "second"]);
  });

  it("leaves a corrupt file in place when read-only", async () => {
    await writeFile(path, "{ nope");
    const state = await loadState(path, { now: NOW, readOnly: true });
    expect(state.entries.size).toBe(0);
    expect(await readdir(dir)).toEqual(["notified.json"]);
    expect(await readFile(path, "utf8")).toBe("{ nope");
    expect(logs.join("")).toContain("left in place");
  });

  it("drops only the invalid entries", async () => {
    const good = { s: "n", f: "2026-10-20", l: "2026-10-25" };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-25T00:00:00Z",
        entries: {
          [A]: good,
          [B]: { s: "x", f: "2026-10-20", l: "2026-10-25" },
          [C]: { s: "i", f: "2026/10/20", l: "2026-10-25" },
          ["d".repeat(32)]: { s: "n", f: "2026-10-20", l: "2026-13-01" },
          ["e".repeat(32)]: { s: "n", f: "2026-02-30", l: "2026-10-25" },
          "not-a-key": good,
        },
      }),
    );
    const state = await loadState(path);
    expect([...state.entries]).toEqual([[A, good]]);
    expect(logs.join("")).toContain("dropped 5 invalid entries");
    // An impossible day that got through would make this throw.
    expect(pruneState(state, 45, "2026-10-26")).toBe(0);
  });

  it("throws when the file exists but cannot be read", async () => {
    await mkdir(path);
    await expect(loadState(path)).rejects.toBeInstanceOf(StateError);
  });
});

describe("pruneState", () => {
  it("expires entries by the day they were last seen", () => {
    const state = stateOf({
      [A]: { s: "n", f: "2026-01-01", l: "2026-09-10" }, // seen 45 days ago: kept
      [B]: { s: "i", f: "2026-09-09", l: "2026-09-09" }, // 46 days ago: removed
      [C]: { s: "n", f: "2025-01-01", l: "2026-10-25" }, // first seen long ago but still in a feed
      ["d".repeat(32)]: { s: "r", f: "2026-09-01", l: "2026-09-01" }, // pending expires the same way
    });
    expect(pruneState(state, 45, "2026-10-25")).toBe(2);
    expect([...state.entries.keys()]).toEqual([A, C]);
  });
});

describe("isKnown", () => {
  it("knows an item by any of its keys", () => {
    const state = stateOf({ [B]: { s: "n", f: "2026-10-20", l: "2026-10-20" } });
    expect(isKnown(state, [A, B])).toBe(true);
    expect(isKnown(state, [B])).toBe(true);
    expect(isKnown(state, [A, C])).toBe(false);
  });
});

describe("statusOf", () => {
  it("is the strongest status under any key: notified, then irrelevant, then pending", () => {
    const state = stateOf({
      [A]: { s: "r", f: "2026-10-20", l: "2026-10-20" },
      [B]: { s: "i", f: "2026-10-20", l: "2026-10-20" },
      [C]: { s: "n", f: "2026-10-20", l: "2026-10-20" },
    });
    expect(statusOf(state, [A])).toBe("r");
    expect(statusOf(state, [A, B])).toBe("i");
    expect(statusOf(state, [A, B, C])).toBe("n");
    expect(statusOf(state, ["d".repeat(32)])).toBeUndefined();
  });
});

describe("touch", () => {
  it("keeps a pending item pending", () => {
    const state = stateOf({ [A]: { s: "r", f: "2026-10-24", l: "2026-10-24" } });
    touch(state, [A, B], "2026-10-25");
    expect(state.entries.get(A)).toEqual({ s: "r", f: "2026-10-24", l: "2026-10-25" });
    expect(state.entries.get(B)).toEqual({ s: "r", f: "2026-10-24", l: "2026-10-25" });
  });

  it("updates the last-seen day and fills in missing keys from the known entry", () => {
    const state = stateOf({ [A]: { s: "n", f: "2026-10-01", l: "2026-10-20" } });
    touch(state, [A, B], "2026-10-25");
    expect(Object.fromEntries(state.entries)).toEqual({
      [A]: { s: "n", f: "2026-10-01", l: "2026-10-25" },
      [B]: { s: "n", f: "2026-10-01", l: "2026-10-25" },
    });
  });

  it("keeps the earliest first-seen day and prefers notified across keys", () => {
    const state = stateOf({
      [A]: { s: "i", f: "2026-10-10", l: "2026-10-20" },
      [B]: { s: "n", f: "2026-10-05", l: "2026-10-21" },
    });
    touch(state, [A, B], "2026-10-25");
    expect(state.entries.get(A)).toEqual({ s: "n", f: "2026-10-05", l: "2026-10-25" });
    expect(state.entries.get(B)).toEqual({ s: "n", f: "2026-10-05", l: "2026-10-25" });
  });

  it("does nothing for an unknown item", () => {
    const state = emptyState();
    touch(state, [A, B], "2026-10-25");
    expect(state.entries.size).toBe(0);
  });
});

describe("record", () => {
  it("records a new item under every key", () => {
    const state = emptyState();
    record(state, [A, B], "i", "2026-10-25");
    expect(Object.fromEntries(state.entries)).toEqual({
      [A]: { s: "i", f: "2026-10-25", l: "2026-10-25" },
      [B]: { s: "i", f: "2026-10-25", l: "2026-10-25" },
    });
  });

  it("keeps the first-seen day and upgrades irrelevant to notified", () => {
    const state = stateOf({ [A]: { s: "i", f: "2026-10-01", l: "2026-10-20" } });
    record(state, [A], "n", "2026-10-25");
    expect(state.entries.get(A)).toEqual({ s: "n", f: "2026-10-01", l: "2026-10-25" });
  });

  it("upgrades pending to irrelevant or notified", () => {
    const state = stateOf({
      [A]: { s: "r", f: "2026-10-01", l: "2026-10-20" },
      [B]: { s: "r", f: "2026-10-01", l: "2026-10-20" },
    });
    record(state, [A], "i", "2026-10-25");
    record(state, [B], "n", "2026-10-25");
    expect(state.entries.get(A)?.s).toBe("i");
    expect(state.entries.get(B)?.s).toBe("n");
  });

  it("never makes an irrelevant or notified item pending again", () => {
    const state = stateOf({
      [A]: { s: "i", f: "2026-10-01", l: "2026-10-20" },
      [B]: { s: "n", f: "2026-10-01", l: "2026-10-20" },
    });
    record(state, [A], "r", "2026-10-25");
    record(state, [B], "r", "2026-10-25");
    expect(state.entries.get(A)?.s).toBe("i");
    expect(state.entries.get(B)?.s).toBe("n");
  });

  it("never downgrades notified to irrelevant", () => {
    const state = stateOf({ [A]: { s: "n", f: "2026-10-01", l: "2026-10-20" } });
    record(state, [A, B], "i", "2026-10-25");
    expect(state.entries.get(A)?.s).toBe("n");
    expect(state.entries.get(B)?.s).toBe("n");
  });
});

describe("saveState", () => {
  it("writes sorted keys, one entry per line, and reads back the same state", async () => {
    const state = stateOf({
      [C]: { s: "n", f: "2026-10-20", l: "2026-10-25" },
      [A]: { s: "i", f: "2026-10-21", l: "2026-10-24" },
    });
    await saveState(state, path, { now: NOW });
    expect(await readFile(path, "utf8")).toBe(
      [
        "{",
        '  "version": 1,',
        '  "updatedAt": "2026-10-25T22:17:03Z",',
        '  "entries": {',
        `    "${A}": {"s":"i","f":"2026-10-21","l":"2026-10-24"},`,
        `    "${C}": {"s":"n","f":"2026-10-20","l":"2026-10-25"}`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const loaded = await loadState(path);
    expect([...loaded.entries]).toEqual([...state.entries].sort(([a], [b]) => a.localeCompare(b)));
  });

  it("writes an empty state that loads back", async () => {
    await saveState(emptyState(), path, { now: NOW });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      updatedAt: "2026-10-25T22:17:03Z",
      entries: {},
    });
    expect((await loadState(path)).entries.size).toBe(0);
  });

  it("creates the parent directory", async () => {
    const nested = join(dir, "state", "notified.json");
    await saveState(emptyState(), nested);
    expect((await loadState(nested)).entries.size).toBe(0);
  });

  it("leaves the old file and no temporary file behind when the write fails", async () => {
    await writeFile(path, "old");
    fail.write = true;
    await expect(saveState(emptyState(), path)).rejects.toBeInstanceOf(StateError);
    expect(await readFile(path, "utf8")).toBe("old");
    expect(await readdir(dir)).toEqual(["notified.json"]);
  });

  it("reports the write error even when the cleanup fails too", async () => {
    fail.write = true;
    fail.rm = true;
    const err = await saveState(emptyState(), path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateError);
    expect((err as StateError).cause).toBe(ENOSPC);
  });
});
