import type { Schedule } from "../config/schema.js";
import { DAY_MS } from "../util/time.js";

/** "*" or the values it matches, sorted and without duplicates. */
export type Field = "*" | readonly number[];

/**
 * When a job runs, in one time zone, with cron's meaning: a run happens at every minute that
 * matches all fields, except that when both dayOfMonth and weekday are restricted, and neither
 * was written starting with "*", a day matches either of them. Every backend is rendered from
 * this.
 */
export interface Calendar {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  /** 0 is Sunday. */
  weekday: Field;
  /**
   * The step n of fields written starting with "*" ("*\/n"; 1 for "*,..."). Vixie cron treats a
   * day-of-month or weekday field that starts with "*" as unrestricted for the either-day rule
   * (DOM_STAR / DOW_STAR), so "0 9 *\/2 * 1" runs on odd-dated Mondays, and toCron writes the
   * step back so the installed line keeps that meaning.
   */
  stars?: Partial<Record<FieldName, number>>;
}

type FieldName = Exclude<keyof Calendar, "stars">;

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const DEFAULT_TIME = "06:17";

const BOUNDS: Record<FieldName, readonly [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  weekday: [0, 6],
};
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Cron's weekday names, 0 (Sunday) first. */
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const FIELD_ORDER: readonly FieldName[] = ["minute", "hour", "dayOfMonth", "month", "weekday"];
const MINUTES_PER_DAY = 24 * 60;

/** A schedule that cannot be parsed or moved; commands turn it into a ConfigError. */
export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

export function calendarOf(schedule: Schedule): Calendar {
  if (schedule.interval === "cron") return parseCron(schedule.cronjob ?? "");
  const { hour, minute } = parseTime(schedule.time ?? DEFAULT_TIME);
  const days = schedule.day === undefined ? ["monday" as const] : [schedule.day].flat();
  return {
    minute: [minute],
    hour: [hour],
    // Like dependabot, monthly runs on the 1st.
    dayOfMonth: schedule.interval === "monthly" ? [1] : "*",
    month: "*",
    weekday: schedule.interval === "weekly" ? sorted(days.map((d) => WEEKDAYS.indexOf(d))) : "*",
  };
}

export function parseTime(time: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new CalendarError(`"${time}" is not a time (use HH:MM, 24-hour)`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * The five-field cron syntax: numbers, *, ranges, lists and steps, with month and weekday names.
 * Shorthands (@daily) and the L, W and # extensions are rejected rather than half supported.
 */
export function parseCron(expr: string): Calendar {
  // A newline would end the one-line comment the expression is echoed into (the workflow, the plist).
  if (/[^\S \t]/.test(expr.trim())) throw new CalendarError("a cron expression must be on one line");
  const parts = cronFields(expr);
  if (parts.length !== 5) {
    throw new CalendarError(`"${expr}" must have 5 fields (minute hour day-of-month month day-of-week)`);
  }
  const parsed = FIELD_ORDER.map((name, i) => parseField(parts[i] ?? "", name));
  const [minute, hour, dayOfMonth, month, weekday] = parsed.map((p) => p.field) as [Field, Field, Field, Field, Field];
  const cal: Calendar = { minute, hour, dayOfMonth, month, weekday };
  const stars = Object.fromEntries(
    FIELD_ORDER.flatMap((name, i) => (parsed[i]?.star === undefined ? [] : [[name, parsed[i].star]])),
  );
  return Object.keys(stars).length > 0 ? { ...cal, stars } : cal;
}

function cronFields(expr: string): string[] {
  return expr.trim().split(/[ \t]+/);
}

/** star: the step of the first item, when the field starts with "*" (as Vixie cron checks it). */
function parseField(text: string, name: FieldName): { field: Field; star?: number } {
  if (text === "*") return { field: "*" };
  const [min, max] = BOUNDS[name];
  const values = new Set<number>();
  let star: number | undefined;
  for (const [i, item] of text.split(",").entries()) {
    const m = /^(\*|[a-z0-9]+)(?:-([a-z0-9]+))?(?:\/(\d+))?$/i.exec(item);
    if (!m) throw new CalendarError(`"${item}" in the ${label(name)} field is not valid cron syntax`);
    // The first group always matches; the default only satisfies the type.
    const [, from = "", to, stepText] = m;
    if (from === "*" && to !== undefined) throw new CalendarError(`"${item}" in the ${label(name)} field is not valid`);
    const start = from === "*" ? min : value(from, name);
    // "5/10" means from 5 to the end, as in most crons.
    const end = from === "*" ? max : to !== undefined ? value(to, name) : stepText !== undefined ? max : start;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new CalendarError(`"${item}" in the ${label(name)} field has a zero step`);
    if (start > end) throw new CalendarError(`"${item}" in the ${label(name)} field is a backwards range`);
    if (i === 0 && from === "*") star = step;
    // 7 is Sunday as well as 0.
    for (let v = start; v <= end; v += step) values.add(name === "weekday" && v === 7 ? 0 : v);
  }
  return { field: sorted([...values]), star };
}

/** What "*\/step" matches in the field. */
function starValues(name: FieldName, step: number): number[] {
  const [min, max] = BOUNDS[name];
  const values: number[] = [];
  for (let v = min; v <= max; v += step) values.push(v);
  return values;
}

/** The star step still describes values when they hold all it matches, so it can be written back. */
function keepStar(name: FieldName, step: number | undefined, values: Field): number | undefined {
  if (step === undefined || values === "*") return undefined;
  return starValues(name, step).every((v) => values.includes(v)) ? step : undefined;
}

/**
 * Whether a day matches when either dayOfMonth or weekday does, rather than both: cron's rule
 * when both are restricted and neither starts with "*".
 */
export function eitherDay(cal: Calendar): boolean {
  const starred = (name: "dayOfMonth" | "weekday") => cal[name] === "*" || cal.stars?.[name] !== undefined;
  return !starred("dayOfMonth") && !starred("weekday");
}

function value(token: string, name: FieldName): number {
  const names: readonly string[] = name === "month" ? MONTH_NAMES : name === "weekday" ? DAY_NAMES : [];
  const named = names.indexOf(token.toLowerCase());
  if (named >= 0) return name === "month" ? named + 1 : named;
  const [min, max] = BOUNDS[name];
  // 7 is accepted as Sunday only where it is written; * stops at 6.
  const top = name === "weekday" ? 7 : max;
  const n = /^\d+$/.test(token) ? Number(token) : Number.NaN;
  if (!(n >= min && n <= top)) {
    throw new CalendarError(`"${token}" is out of range for the ${label(name)} field (${min}-${top})`);
  }
  return n;
}

function label(name: FieldName): string {
  return { minute: "minute", hour: "hour", dayOfMonth: "day-of-month", month: "month", weekday: "day-of-week" }[name];
}

/**
 * Back to five cron fields, writing runs of consecutive values as ranges, and a field written
 * starting with "*" as "*\/n" again (then any other values), so cron reads the same day rule.
 */
export function toCron(cal: Calendar): string {
  return FIELD_ORDER.map((name) => {
    const field = cal[name];
    if (field === "*") return "*";
    const step = keepStar(name, cal.stars?.[name], field);
    const covered = step === undefined ? [] : starValues(name, step);
    const rest = field.filter((v) => !covered.includes(v));
    const parts: string[] = step === undefined ? [] : [step === 1 ? "*" : `*/${step}`];
    for (const run of consecutiveRuns(rest)) {
      parts.push(run.length >= 3 ? `${run[0]}-${run.at(-1)}` : run.join(","));
    }
    return parts.join(",");
  }).join(" ");
}

/** Sorted values split where they stop going up by one: [1, 2, 3, 5] is [[1, 2, 3], [5]]. */
function consecutiveRuns(values: readonly number[]): number[][] {
  const runs: number[][] = [];
  for (const v of values) {
    const last = runs.at(-1);
    if (last !== undefined && last.at(-1) === v - 1) last.push(v);
    else runs.push([v]);
  }
  return runs;
}

// Building a formatter costs far more than using one, and counting a month of runs every minute
// asks for thousands of offsets.
const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** The offset of timeZone from UTC at the given instant, in minutes (Asia/Tokyo is 540). */
export function offsetMinutes(timeZone: string, at: Date): number {
  let format = offsetFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormats.set(timeZone, format);
  }
  const name = format.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The same runs on another clock: launchd and cron read the machine's, Actions reads UTC. Moves
 * the minutes and hours, and the weekdays when the runs cross midnight. Throws a CalendarError
 * when the result is not expressible as one calendar, and warns when daylight saving time makes
 * the offset between the zones change during the year (the backends cannot follow it).
 */
export function convertZone(
  cal: Calendar,
  from: string,
  to: string,
  now: Date,
): { calendar: Calendar; warnings: string[] } {
  if (from === to) return { calendar: cal, warnings: [] };
  const warnings: string[] = [];
  const deltaAt = (at: Date) => offsetMinutes(to, at) - offsetMinutes(from, at);
  const year = now.getUTCFullYear();
  const winter = deltaAt(new Date(Date.UTC(year, 0, 15)));
  const summer = deltaAt(new Date(Date.UTC(year, 6, 15)));
  if (winter !== summer) {
    warnings.push(
      `the offset between ${from} and ${to} changes with daylight saving time, so runs move by ${hours(Math.abs(winter - summer))} for part of the year; install again after the change, or set schedule.timezone to ${to}`,
    );
  }
  const delta = deltaAt(now);
  if (delta === 0) return { calendar: cal, warnings };

  const cannot = (why: string) =>
    new CalendarError(`the schedule cannot be moved from ${from} to ${to} (${why}); set schedule.timezone to ${to}`);
  const shifted = expand(cal.hour, "hour").flatMap((h) =>
    expand(cal.minute, "minute").map((m) => {
      const t = h * 60 + m + delta;
      const inDay = mod(t, MINUTES_PER_DAY);
      return { day: Math.floor(t / MINUTES_PER_DAY), hour: Math.floor(inDay / 60), minute: inDay % 60 };
    }),
  );
  const newHours = sorted(shifted.map((s) => s.hour));
  const newMinutes = sorted(shifted.map((s) => s.minute));
  // The moved times are distinct, so they form a grid exactly when the counts multiply out.
  if (newHours.length * newMinutes.length !== shifted.length) {
    throw cannot("its times do not stay one set of hours and minutes");
  }
  const days = sorted(shifted.map((s) => s.day));
  const restricted = cal.dayOfMonth !== "*" || cal.month !== "*" || cal.weekday !== "*";
  if (restricted && days.length > 1) throw cannot("some runs would move to another day and some would not");
  const dayShift = restricted ? (days[0] ?? 0) : 0;
  if (dayShift !== 0 && (cal.dayOfMonth !== "*" || cal.month !== "*")) {
    throw cannot("the runs would move to another day of the month");
  }
  const moved: Calendar = {
    ...cal,
    minute: collapse(newMinutes, "minute"),
    hour: collapse(newHours, "hour"),
    weekday: cal.weekday === "*" ? "*" : sorted(cal.weekday.map((w) => mod(w + dayShift, 7))),
  };
  // A moved field keeps its "*/n" only if it still matches all of it. A weekday that loses it
  // only moves when dayOfMonth is "*", where the either-day rule does not apply anyway.
  const stars = Object.fromEntries(
    FIELD_ORDER.flatMap((name) => {
      const step = keepStar(name, cal.stars?.[name], moved[name]);
      return step === undefined ? [] : [[name, step]];
    }),
  );
  const { stars: _, ...rest } = moved;
  return { calendar: Object.keys(stars).length > 0 ? { ...rest, stars } : rest, warnings };
}

/**
 * The longest wait between two runs, in whole days and at least one (a daylight saving change
 * does not make a day of a weekly gap). Undefined when there are not two runs in 5 years.
 */
export function longestGapDays(cal: Calendar, timeZone: string, from: Date): number | undefined {
  // Enough runs to go round a weekly or monthly cycle several times.
  const runs = nextRuns(cal, timeZone, from, 60);
  if (runs.length < 2) return undefined;
  let gap = 0;
  for (const [i, run] of runs.entries()) {
    const previous = runs[i - 1];
    if (previous) gap = Math.max(gap, run.getTime() - previous.getTime());
  }
  return Math.max(1, Math.round(gap / DAY_MS));
}

/** The next n runs after from, reading the calendar on timeZone's clock. Looks up to 5 years ahead. */
export function nextRuns(cal: Calendar, timeZone: string, from: Date, n: number): Date[] {
  const runs: Date[] = [];
  const start = from.getTime();
  const today = wallDate(timeZone, from);
  for (let i = 0; i < 366 * 5 && runs.length < n; i++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const [year, month, date] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (!dayMatches(cal, month, date, day.getUTCDay())) continue;
    for (const h of expand(cal.hour, "hour")) {
      for (const m of expand(cal.minute, "minute")) {
        const at = zonedInstant(timeZone, year, month, date, h, m);
        if (at.getTime() <= start) continue;
        runs.push(at);
        if (runs.length === n) return runs;
      }
    }
  }
  return runs;
}

function dayMatches(cal: Calendar, month: number, date: number, weekday: number): boolean {
  const has = (field: Field, v: number) => field === "*" || field.includes(v);
  if (!has(cal.month, month)) return false;
  if (eitherDay(cal)) return has(cal.dayOfMonth, date) || has(cal.weekday, weekday);
  return has(cal.dayOfMonth, date) && has(cal.weekday, weekday);
}

/** The instant moved so its UTC fields read as timeZone's clock. */
function onClock(timeZone: string, at: Date): Date {
  return new Date(at.getTime() + offsetMinutes(timeZone, at) * 60_000);
}

function wallDate(timeZone: string, at: Date): { year: number; month: number; day: number } {
  const local = onClock(timeZone, at);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

/** "Mon 2026-11-02 06:17", on timeZone's clock. */
export function wallTime(at: Date, timeZone: string): string {
  const local = onClock(timeZone, at);
  return `${capitalize(DAY_NAMES[local.getUTCDay()] ?? "")} ${local.toISOString().slice(0, 16).replace("T", " ")}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function zonedInstant(timeZone: string, year: number, month: number, day: number, h: number, m: number): Date {
  const wall = Date.UTC(year, month - 1, day, h, m);
  // Twice, so a guess on the other side of a DST change is corrected by the offset where it lands.
  const first = wall - offsetMinutes(timeZone, new Date(wall)) * 60_000;
  return new Date(wall - offsetMinutes(timeZone, new Date(first)) * 60_000);
}

/** "weekly on Monday and Thursday at 06:17 (Asia/Tokyo)" */
export function describeSchedule(schedule: Schedule, timeZone: string): string {
  const at = `at ${schedule.time ?? DEFAULT_TIME}`;
  const what = (() => {
    switch (schedule.interval) {
      case "daily":
        return `daily ${at}`;
      case "weekly": {
        const days = (schedule.day === undefined ? ["monday"] : [schedule.day].flat()).map(capitalize);
        const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days.at(-1)}` : days[0];
        return `weekly on ${list} ${at}`;
      }
      case "monthly":
        return `monthly on the 1st ${at}`;
      case "cron":
        // Normalized, so the summary stays one line whatever the config holds.
        return `cron "${cronFields((schedule.cronjob ?? "").replace(/\s+/g, " ")).join(" ")}"`;
    }
  })();
  return `${what} (${timeZone})`;
}

function expand(field: Field, name: FieldName): readonly number[] {
  if (field !== "*") return field;
  const [min, max] = BOUNDS[name];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

function collapse(values: readonly number[], name: FieldName): Field {
  const [min, max] = BOUNDS[name];
  return values.length === max - min + 1 ? "*" : values;
}

function sorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function hours(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`;
}
