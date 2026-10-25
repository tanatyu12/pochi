const DAY_MS = 86_400_000;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Dates in the state file are UTC calendar days ("2026-10-25").
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Second precision keeps the state file diff readable ("2026-10-25T22:17:03Z").
export function toIsoSeconds(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function addDays(isoDate: string, days: number): string {
  return toIsoDate(new Date(dateMs(isoDate) + days * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dateMs(to) - dateMs(from)) / DAY_MS);
}

// V8's fallback parser accepts junk ("1" is 2001-01-01) and rolls over impossible days
// ("2026-02-30" is March 2), so only the formats feeds use reach new Date.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/i;
const RFC_2822_DATE =
  /^(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:[+-]\d{4}|[a-z]{1,5}))?$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseDate(s: string | undefined): Date | undefined {
  const trimmed = s?.trim();
  if (!trimmed) return undefined;
  let year: number;
  let month: number;
  let day: number;
  const iso = ISO_DATE.exec(trimmed);
  const rfc = iso ? null : RFC_2822_DATE.exec(trimmed);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (rfc) {
    [year, month, day] = [Number(rfc[3]), MONTHS.indexOf(rfc[2]?.toLowerCase() ?? "") + 1, Number(rfc[1])];
  } else {
    return undefined;
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateMs(isoDate: string): number {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new RangeError(`invalid date: ${isoDate}`);
  return ms;
}
