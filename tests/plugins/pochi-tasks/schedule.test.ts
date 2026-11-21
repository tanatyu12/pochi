import { describe, expect, it } from "vitest";
import { type CalendarEntry, sameCalendar, shiftCalendar } from "../../../plugins/pochi-tasks/scripts/pochi-tasks.mjs";

// Whether a launchd entry fires at a moment: every key present must match.
function fires(e: CalendarEntry, d: Date): boolean {
  return (
    (e.Minute === undefined || e.Minute === d.getMinutes()) &&
    (e.Hour === undefined || e.Hour === d.getHours()) &&
    (e.Day === undefined || e.Day === d.getDate()) &&
    (e.Month === undefined || e.Month === d.getMonth() + 1) &&
    (e.Weekday === undefined || e.Weekday % 7 === d.getDay())
  );
}

// For every Pochi run over two years, the shifted calendar must fire after it and no later than
// the delay: the issue job then always sees the report it follows.
function expectFollows(entries: CalendarEntry[], minutes: number) {
  const shifted = shiftCalendar(entries, minutes);
  const start = new Date(2027, 0, 1).getTime();
  const end = new Date(2029, 0, 1).getTime();
  let runs = 0;
  for (let t = start; t < end; t += 60_000) {
    const d = new Date(t);
    if (!entries.some((e) => fires(e, d))) continue;
    runs++;
    const next = new Date(t + minutes * 60_000);
    expect(shifted.some((e) => fires(e, next)), `no issue run ${minutes} min after ${d.toString()}`).toBe(true);
  }
  expect(runs).toBeGreaterThan(0);
  return shifted;
}

describe("shiftCalendar", () => {
  it("does shift a time that stays within the day", () => {
    expect(shiftCalendar([{ Hour: 7, Minute: 0, Weekday: 1 }], 30)).toEqual([{ Hour: 7, Minute: 30, Weekday: 1 }]);
  });

  it("does move a daily run past midnight to the next day's time", () => {
    expect(expectFollows([{ Hour: 23, Minute: 45 }], 30)).toEqual([{ Hour: 0, Minute: 15 }]);
  });

  it("does move a Saturday run past midnight to Sunday", () => {
    expect(expectFollows([{ Weekday: 6, Hour: 23, Minute: 50 }], 30)).toEqual([{ Weekday: 0, Hour: 0, Minute: 20 }]);
  });

  it("does wrap Sunday written as 7", () => {
    expect(shiftCalendar([{ Weekday: 7, Hour: 23, Minute: 50 }], 30)).toEqual([{ Weekday: 1, Hour: 0, Minute: 20 }]);
  });

  it("does keep a monthly day that still exists in every month after the shift", () => {
    expect(expectFollows([{ Day: 27, Hour: 23, Minute: 45 }], 30)).toEqual([{ Day: 28, Hour: 0, Minute: 15 }]);
  });

  it("does not run before a monthly Pochi run late on day 28", () => {
    expect(expectFollows([{ Day: 28, Hour: 23, Minute: 45 }], 30)).toEqual([{ Hour: 0, Minute: 15 }]);
  });

  it("does not run before a monthly Pochi run on day 31", () => {
    expectFollows([{ Day: 31, Hour: 23, Minute: 45 }], 30);
  });

  it("does drop a month restriction the day after crosses out of", () => {
    expectFollows([{ Month: 3, Hour: 23, Minute: 45 }], 30);
    expectFollows([{ Month: 2, Day: 28, Hour: 23, Minute: 45 }], 30);
  });

  it("does keep a run after the last hourly run of a restricted day", () => {
    const shifted = expectFollows([{ Weekday: 6, Minute: 50 }], 30);
    expect(shifted).toContainEqual({ Weekday: 6, Minute: 20 });
  });

  it("does handle delays longer than a day", () => {
    expectFollows([{ Weekday: 5, Hour: 22, Minute: 0 }], 26 * 60);
  });
});

describe("sameCalendar", () => {
  it("does ignore the order of keys inside an entry, as plutil writes them", () => {
    const shifted = shiftCalendar([{ Minute: 50, Weekday: 1 }], 20);
    const fromPlutil = shifted.map((e) => Object.fromEntries(Object.entries(e).sort()));
    expect(JSON.stringify(shifted)).not.toBe(JSON.stringify(fromPlutil));
    expect(sameCalendar(shifted, fromPlutil)).toBe(true);
  });

  it("does tell different times apart", () => {
    expect(sameCalendar([{ Hour: 8, Minute: 0 }], [{ Hour: 8, Minute: 30 }])).toBe(false);
    expect(sameCalendar([{ Hour: 8, Minute: 0 }], [])).toBe(false);
  });
});
