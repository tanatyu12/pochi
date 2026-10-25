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

export function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function dateMs(isoDate: string): number {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new RangeError(`invalid date: ${isoDate}`);
  return ms;
}
