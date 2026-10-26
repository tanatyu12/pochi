import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ExitCode, PochiError } from "../errors.js";
import { log } from "../util/log.js";
import { daysBetween, toIsoSeconds } from "../util/time.js";

export const DEFAULT_STATE_PATH = "state/notified.json";

/**
 * n: notified. i: judged irrelevant, so it is not triaged again. r: judged relevant but not yet
 * analyzed, so the next run analyzes it without triaging it again.
 */
export type EntryStatus = "n" | "i" | "r";

// A later decision never weakens an earlier one: notified beats irrelevant beats pending.
const RANK: Record<EntryStatus, number> = { n: 2, i: 1, r: 0 };

export interface StateEntry {
  s: EntryStatus;
  /** UTC day the item was first seen. */
  f: string;
  /** UTC day the item was last seen in a feed. */
  l: string;
}

export interface State {
  entries: Map<string, StateEntry>;
}

export class StateError extends PochiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.INTERNAL, options);
  }
}

// Entries are checked one by one, so only the envelope has to be intact.
const FileSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), z.unknown()) });
const KEY = /^[0-9a-f]{32}$/;
// A calendar check, not just the shape: "2026-13-01" would make pruneState throw.
const day = z.iso.date();
const EntrySchema = z.object({ s: z.enum(["n", "i", "r"]), f: day, l: day });

export function emptyState(): State {
  return { entries: new Map() };
}

export function resolveStatePath(opts: { flag?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const fromFlag = opts.flag?.trim();
  const fromEnv = (opts.env ?? process.env).POCHI_STATE_PATH?.trim();
  return fromFlag || fromEnv || DEFAULT_STATE_PATH;
}

/**
 * A missing file is an empty state. A file that is not a state file is moved aside and the run
 * starts empty; any other read failure throws, since starting empty would notify everything again.
 * With readOnly (a dry run), a file that is not a state file is left in place.
 */
export async function loadState(path: string, opts: { now?: Date; readOnly?: boolean } = {}): Promise<State> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new StateError(`cannot read ${path}`, { cause: err });
  }

  const file = FileSchema.safeParse(parseJson(text));
  if (!file.success) {
    if (opts.readOnly) {
      log.warn(`${path} is not a valid state file; starting empty (left in place)`);
      return emptyState();
    }
    // The suffix keeps a second corruption within the same second from replacing the first backup.
    const stamp = toIsoSeconds(opts.now ?? new Date()).replace(/[-:]/g, "");
    const backup = `${path}.corrupt-${stamp}-${randomBytes(3).toString("hex")}`;
    try {
      await rename(path, backup);
    } catch (err) {
      throw new StateError(`cannot move aside the corrupt ${path}`, { cause: err });
    }
    log.warn(`${path} is not a valid state file; moved it to ${backup} and starting empty`);
    return emptyState();
  }

  const state = emptyState();
  let dropped = 0;
  for (const [key, value] of Object.entries(file.data.entries)) {
    const entry = EntrySchema.safeParse(value);
    if (KEY.test(key) && entry.success) state.entries.set(key, entry.data);
    else dropped++;
  }
  // One damaged line should not cost the whole history.
  if (dropped > 0) log.warn(`dropped ${dropped} invalid entries from ${path}`);
  return state;
}

/** Removes entries not seen for more than ttlDays, and returns how many were removed. */
export function pruneState(state: State, ttlDays: number, today: string): number {
  // l, not f: a stale blog keeps old posts in its feed, and expiring them by first sight would
  // notify them again once the TTL passed.
  let removed = 0;
  for (const [key, entry] of state.entries) {
    if (daysBetween(entry.l, today) > ttlDays) {
      state.entries.delete(key);
      removed++;
    }
  }
  return removed;
}

export function isKnown(state: State, keys: readonly string[]): boolean {
  return keys.some((k) => state.entries.has(k));
}

/** The strongest status under any of the keys, or undefined for an item the state does not know. */
export function statusOf(state: State, keys: readonly string[]): EntryStatus | undefined {
  return strongest(existing(state, keys).map((e) => e.s));
}

/** The earliest day any of the keys was first seen, or undefined for an item the state does not know. */
export function firstSeen(state: State, keys: readonly string[]): string | undefined {
  return existing(state, keys).reduce<string | undefined>((min, e) => (min === undefined || e.f < min ? e.f : min), undefined);
}

/**
 * Marks a known item as seen today under every key. Keys the state lacks (a page first seen under
 * another source) inherit the known entry, so the next run finds it by any of them.
 */
export function touch(state: State, keys: readonly string[], today: string): void {
  // r is the weakest status, so recording it keeps whatever the item already had.
  if (isKnown(state, keys)) record(state, keys, "r", today);
}

/**
 * Records a decision under every key. A status is never weakened: a notified item does not become
 * irrelevant, and neither becomes pending again.
 */
export function record(state: State, keys: readonly string[], status: EntryStatus, today: string): void {
  const known = existing(state, keys);
  write(state, keys, merged(known, strongest([status, ...known.map((e) => e.s)])!, today));
}

export async function saveState(state: State, path: string, opts: { now?: Date } = {}): Promise<void> {
  const updatedAt = toIsoSeconds(opts.now ?? new Date());
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(serialize(state, updatedAt));
      // Without this a crash after the rename can leave an empty file under the real name. The
      // directory is not synced: losing the rename only keeps the old file.
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // A failed cleanup must not hide why the write failed.
    await rm(tmp, { force: true }).catch(() => {});
    throw new StateError(`cannot write ${path}`, { cause: err });
  }
}

// One entry per line keeps the daily commit's diff to the entries that changed; pretty-printing
// would spend five lines on each of tens of thousands of entries.
function serialize(state: State, updatedAt: string): string {
  const keys = [...state.entries.keys()].sort();
  const lines = keys.map((k, i) => {
    const { s, f, l } = state.entries.get(k)!;
    return `    ${JSON.stringify(k)}: ${JSON.stringify({ s, f, l })}${i < keys.length - 1 ? "," : ""}`;
  });
  const entries = lines.length > 0 ? `{\n${lines.join("\n")}\n  }` : "{}";
  return `{\n  "version": 1,\n  "updatedAt": ${JSON.stringify(updatedAt)},\n  "entries": ${entries}\n}\n`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function strongest(statuses: readonly EntryStatus[]): EntryStatus | undefined {
  return statuses.reduce<EntryStatus | undefined>((a, b) => (a === undefined || RANK[b] > RANK[a] ? b : a), undefined);
}

function existing(state: State, keys: readonly string[]): StateEntry[] {
  return keys.flatMap((k) => state.entries.get(k) ?? []);
}

function merged(known: StateEntry[], s: EntryStatus, today: string): StateEntry {
  const f = known.reduce((min, e) => (e.f < min ? e.f : min), today);
  return { s, f, l: today };
}

function write(state: State, keys: readonly string[], entry: StateEntry): void {
  for (const k of keys) state.entries.set(k, { ...entry });
}
