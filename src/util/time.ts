export const DAY_MS = 86_400_000;

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
// ("2026-02-30" is March 2), so only the formats feeds use are accepted. ISO goes to new Date,
// which parses it strictly; RFC 2822 is put together here, because V8 knows only the US zones.
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:([T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:(Z)|([+-]\d{2}):?(\d{2}))?)?$/i;
const RFC_2822_DATE =
  /^(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4}|\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(?:([+-])(\d{2}):?(\d{2})|([a-z]{1,5})))?$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Minutes east of UTC. The first line is what V8 itself accepts, kept as V8 reads it (CST is US
// Central); the rest are zones feeds outside the US commonly write. IST is India.
const ZONES: Record<string, number> = {
  ut: 0, utc: 0, gmt: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420,
  hst: -600, akst: -540, akdt: -480,
  wet: 0, west: 60, bst: 60, cet: 60, cest: 120, eet: 120, eest: 180, msk: 180,
  ist: 330, ict: 420, wib: 420, hkt: 480, sgt: 480, awst: 480, jst: 540, kst: 540,
  acst: 570, acdt: 630, aest: 600, aedt: 660, nzst: 720, nzdt: 780,
};

export function parseDate(s: string | undefined): Date | undefined {
  const trimmed = s?.trim();
  if (!trimmed) return undefined;
  const iso = ISO_DATE.exec(trimmed);
  if (iso) {
    if (!isRealDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return undefined;
    // new Date wants the offset as +09:00.
    const offset = iso[5] ?? (iso[6] ? `${iso[6]}:${iso[7]}` : "");
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}${iso[4] ?? ""}${offset}`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const rfc = RFC_2822_DATE.exec(trimmed);
  if (!rfc) return undefined;
  const day = Number(rfc[1]);
  const month = MONTHS.indexOf(rfc[2]?.toLowerCase() ?? "") + 1;
  const rawYear = Number(rfc[3]);
  // RFC 2822 section 4.3: a two-digit year below 50 is 20xx, otherwise 19xx.
  const year = rfc[3]?.length === 2 ? rawYear + (rawYear < 50 ? 2000 : 1900) : rawYear;
  const [hour, minute, second] = [Number(rfc[4]), Number(rfc[5]), Number(rfc[6] ?? 0)];
  if (!isRealDay(year, month, day) || hour > 23 || minute > 59 || second > 59) return undefined;
  let offset: number | undefined;
  if (rfc[7]) {
    if (Number(rfc[9]) > 59) return undefined;
    offset = (rfc[7] === "-" ? -1 : 1) * (Number(rfc[8]) * 60 + Number(rfc[9]));
  } else if (rfc[10]) {
    offset = ZONES[rfc[10].toLowerCase()];
    if (offset === undefined) return undefined;
  }
  // Without a zone V8 reads the time as local, and so does this.
  const d =
    offset === undefined
      ? new Date(year, month - 1, day, hour, minute, second)
      : new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function isRealDay(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateMs(isoDate: string): number {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new RangeError(`invalid date: ${isoDate}`);
  return ms;
}
