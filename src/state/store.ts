import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import * as z from "zod";
import { type Impact, ImpactSchema } from "../config/schema.js";
import { ExitCode, PochiError } from "../errors.js";
import { isEnoent } from "../util/fs.js";
import { log } from "../util/log.js";
import { truncate } from "../util/text.js";
import { daysBetween, toIsoSeconds } from "../util/time.js";

export const DEFAULT_STATE_PATH = "state/notified.json";

/**
 * n: notified (every channel has it). i: judged irrelevant, so it is not triaged again. r: judged
 * relevant but not yet delivered everywhere, so the next run sends it on without triaging it again
 * (and, when a holds its analysis, without analyzing it again). u: collected but not yet triaged
 * (a failed batch, no answer, over maxItemsPerRun), so the next run triages it.
 */
export type EntryStatus = "n" | "i" | "r" | "u";

// A later decision never weakens an earlier one: notified beats irrelevant beats pending beats untriaged.
const RANK: Record<EntryStatus, number> = { n: 3, i: 2, r: 1, u: 0 };

/** What Analyze said about an item, kept so an insight not yet delivered is not paid for again. */
export interface StoredAnalysis {
  title: string;
  summary: string;
  impact: Impact;
  action: string;
}

// Cut where a channel would cut it anyway (a feed title, a Slack section), so the file stays bounded.
export const STORED_TITLE_CHARS = 300;
export const STORED_TEXT_CHARS = 2900;

export interface StateEntry {
  s: EntryStatus;
  /** UTC day the item was first seen. */
  f: string;
  /** UTC day the item was last seen in a feed. */
  l: string;
  /** r only: the channels (Notifier.name) that already have it, so the next run sends it only to the others. */
  c?: string[];
  /** r only: its analysis, so the next run delivers it without analyzing it again. */
  a?: StoredAnalysis;
  /** r only, without a: Item.id of the item it was shown with as a related report, whose fate it shares. */
  p?: string;
}

/** The fields only an r entry has. */
export type EntryExtras = Pick<StateEntry, "c" | "a" | "p">;

export interface State {
  entries: Map<string, StateEntry>;
  /** When the file was last saved, which is when the last run that saved it ran. */
  updatedAt?: Date;
  /**
   * Per source id, where its next fetch starts from (a day before it, as with updatedAt): when it
   * was last fetched, or earlier while items from it still wait in the state.
   */
  sources?: Map<string, Date>;
  /** Runs that delivered at least one update, for the footer's round numbers (notifiers/voice). */
  briefings?: number;
}

export class StateError extends PochiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.INTERNAL, options);
  }
}

// Entries are checked one by one, so only the envelope has to be intact.
const FileSchema = z.object({
  version: z.literal(1),
  // Only tells sources how far back to look, so a bad value is ignored rather than failing the file.
  updatedAt: z.iso.datetime().optional().catch(undefined),
  // Only counts for the footer, so likewise.
  briefings: z.number().int().nonnegative().optional().catch(undefined),
  // Checked one by one: a bad value only sends that source back to updatedAt.
  sources: z.record(z.string(), z.unknown()).optional().catch(undefined),
  entries: z.record(z.string(), z.unknown()),
});
const KEY = /^[0-9a-f]{32}$/;
// A calendar check, not just the shape: "2026-13-01" would make pruneState throw.
const day = z.iso.date();
const AnalysisSchema = z.object({ title: z.string(), summary: z.string(), impact: ImpactSchema, action: z.string() });
// The extras only save work, so a bad one is dropped rather than the entry.
const EntrySchema = z.object({
  s: z.enum(["n", "i", "r", "u"]),
  f: day,
  l: day,
  c: z.array(z.string()).optional().catch(undefined),
  a: AnalysisSchema.optional().catch(undefined),
  p: z.string().regex(KEY).optional().catch(undefined),
});
const SourceTimeSchema = z.iso.datetime();

export function emptyState(): State {
  return { entries: new Map() };
}

/**
 * Where the state lives between runs. run only loads and saves through this, so a store other
 * than a local file (object storage, a database) needs no change to the pipeline. save throws a
 * StateError when the state could not be kept.
 */
export interface StateStore {
  load(opts: { now: Date }): Promise<State>;
  /** now becomes updatedAt, where the next run's since starts. */
  save(state: State, opts: { now: Date }): Promise<void>;
}

/** The state file at path. With readOnly (a dry run), a corrupt file is left in place and save writes nothing. */
export function fileStateStore(path: string, opts: { readOnly?: boolean } = {}): StateStore {
  return {
    load: ({ now }) => loadState(path, { now, readOnly: opts.readOnly }),
    save: async (state, { now }) => {
      if (!opts.readOnly) await saveState(state, path, { now });
    },
  };
}

/** Kept only in this process: --no-state starts empty and leaves nothing behind. */
export function memoryStateStore(): StateStore {
  let text: string | undefined;
  return {
    load: async () => {
      const parsed = text === undefined ? undefined : parseState(text);
      return parsed?.kind === "ok" ? parsed.state : emptyState();
    },
    // Serialized, so later changes to the State object do not alter what was saved.
    save: async (state, { now }) => {
      text = serializeState(state, now);
    },
  };
}

/** Replaces the default state path when --state is not given. */
export const STATE_PATH_ENV = "POCHI_STATE_PATH";

export function resolveStatePath(opts: { flag?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const fromFlag = opts.flag?.trim();
  const fromEnv = (opts.env ?? process.env)[STATE_PATH_ENV]?.trim();
  return fromFlag || fromEnv || DEFAULT_STATE_PATH;
}

/** What is on disk, without moving anything aside or logging; loadState decides what to do with it. */
export type StateInspection =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ok"; state: State; dropped: number };

/** Reads the state file as is. Only a read failure other than a missing file throws. */
export async function inspectState(path: string): Promise<StateInspection> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { kind: "missing" };
    throw new StateError(`cannot read ${path}`, { cause: err });
  }
  return parseState(text);
}

/** The state file's text as a State, for any store that keeps the same JSON document. */
export function parseState(text: string): Exclude<StateInspection, { kind: "missing" }> {
  const file = FileSchema.safeParse(parseJson(text));
  if (!file.success) return { kind: "invalid" };

  const state = emptyState();
  if (file.data.updatedAt !== undefined) state.updatedAt = new Date(file.data.updatedAt);
  if (file.data.briefings !== undefined) state.briefings = file.data.briefings;
  if (file.data.sources !== undefined) {
    state.sources = new Map();
    for (const [id, value] of Object.entries(file.data.sources)) {
      const time = SourceTimeSchema.safeParse(value);
      if (time.success) state.sources.set(id, new Date(time.data));
    }
  }
  let dropped = 0;
  for (const [key, value] of Object.entries(file.data.entries)) {
    const entry = EntrySchema.safeParse(value);
    if (KEY.test(key) && entry.success) state.entries.set(key, bounded(entry.data));
    else dropped++;
  }
  return { kind: "ok", state, dropped };
}

/**
 * A missing file is an empty state. A file that is not a state file is moved aside and the run
 * starts empty; any other read failure throws, since starting empty would notify everything again.
 * With readOnly (a dry run), a file that is not a state file is left in place.
 */
export async function loadState(path: string, opts: { now?: Date; readOnly?: boolean } = {}): Promise<State> {
  const found = await inspectState(path);
  if (found.kind === "missing") return emptyState();
  if (found.kind === "invalid") {
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
  // One damaged line should not cost the whole history.
  if (found.dropped > 0) log.warn(`dropped ${found.dropped} invalid entries from ${path}`);
  return found.state;
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
  // u is the weakest status, so recording it keeps whatever the item already had.
  if (isKnown(state, keys)) record(state, keys, "u", today);
}

/** What the entries under the keys hold beyond their status; empty unless the item is r. */
export function extrasOf(state: State, keys: readonly string[]): EntryExtras {
  const known = existing(state, keys);
  if (strongest(known.map((e) => e.s)) !== "r") return {};
  const { c, a, p } = mergedExtras(known, {});
  return { ...(c.length > 0 && { c }), ...(a && { a }), ...(p && { p }) };
}

/**
 * Records a decision under every key. A status is never weakened: a notified item does not become
 * irrelevant, neither becomes pending again, and none becomes untriaged. extras matter only to an
 * item that stays r: its channels are added to those it had, and a new a or p replaces the old one.
 */
export function record(
  state: State,
  keys: readonly string[],
  status: EntryStatus,
  today: string,
  extras: EntryExtras = {},
): void {
  const known = existing(state, keys);
  write(state, keys, merged(known, strongest([status, ...known.map((e) => e.s)]) ?? status, today, extras));
}

export async function saveState(state: State, path: string, opts: { now?: Date } = {}): Promise<void> {
  const updatedAt = opts.now ?? new Date();
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    // Owner only, like the config files: what a project follows is not for other local users.
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(serializeState(state, updatedAt));
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
export function serializeState(state: State, updatedAt: Date): string {
  const sorted = [...state.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = sorted.map(([k, { s, f, l, c, a, p }], i) => {
    // Fields left undefined are not written, so most entries stay {s, f, l}.
    return `    ${JSON.stringify(k)}: ${JSON.stringify({ s, f, l, c, a, p })}${i < sorted.length - 1 ? "," : ""}`;
  });
  const entries = lines.length > 0 ? `{\n${lines.join("\n")}\n  }` : "{}";
  const briefings = state.briefings === undefined ? "" : `  "briefings": ${state.briefings},\n`;
  const sourceLines = [...(state.sources ?? [])]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, time]) => `    ${JSON.stringify(id)}: ${JSON.stringify(toIsoSeconds(time))}`);
  const sources = sourceLines.length > 0 ? `  "sources": {\n${sourceLines.join(",\n")}\n  },\n` : "";
  return `{\n  "version": 1,\n  "updatedAt": ${JSON.stringify(toIsoSeconds(updatedAt))},\n${briefings}${sources}  "entries": ${entries}\n}\n`;
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

function merged(known: StateEntry[], s: EntryStatus, today: string, extras: EntryExtras): StateEntry {
  const f = known.reduce((min, e) => (e.f < min ? e.f : min), today);
  return bounded({ s, f, l: today, ...mergedExtras(known, extras) });
}

function mergedExtras(known: StateEntry[], extras: EntryExtras): { c: string[]; a?: StoredAnalysis; p?: string } {
  const c = [...new Set([...known.flatMap((e) => e.c ?? []), ...(extras.c ?? [])])].sort();
  if (extras.a !== undefined || extras.p !== undefined) return { c, a: extras.a, p: extras.p };
  const a = known.find((e) => e.a !== undefined)?.a;
  return { c, a, p: a === undefined ? known.find((e) => e.p !== undefined)?.p : undefined };
}

// Only r keeps extras (delivered everywhere or judged irrelevant, they are of no more use); empty
// ones are not kept, and the stored text is cut, so the file stays bounded.
function bounded(entry: StateEntry): StateEntry {
  const { s, f, l, c, a, p } = entry;
  if (s !== "r") return { s, f, l };
  return {
    s,
    f,
    l,
    ...(c !== undefined && c.length > 0 && { c }),
    ...(a !== undefined && {
      a: {
        title: truncate(a.title, STORED_TITLE_CHARS),
        summary: truncate(a.summary, STORED_TEXT_CHARS),
        impact: a.impact,
        action: truncate(a.action, STORED_TEXT_CHARS),
      },
    }),
    ...(a === undefined && p !== undefined && { p }),
  };
}

function write(state: State, keys: readonly string[], entry: StateEntry): void {
  for (const k of keys) state.entries.set(k, { ...entry });
}
