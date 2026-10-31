import { describe, expect, it } from "vitest";
import { ContextSchema } from "../../src/config/schema.js";
import {
  type Calendar,
  CalendarError,
  calendarOf,
  convertZone,
  describeSchedule,
  nextRuns,
  offsetMinutes,
  parseCron,
  toCron,
} from "../../src/schedule/calendar.js";

const NOW = new Date("2026-10-28T03:00:00Z"); // Wed 12:00 in Tokyo

function schedule(input: object) {
  return ContextSchema.parse({ version: 1, project: { name: "a", description: "" }, problems: ["p"], schedule: input })
    .schedule;
}

describe("calendarOf", () => {
  it("defaults to daily at 06:17", () => {
    expect(toCron(calendarOf(schedule({})))).toBe("17 6 * * *");
  });

  it("runs weekly on Monday by default, or on the listed days", () => {
    expect(toCron(calendarOf(schedule({ interval: "weekly" })))).toBe("17 6 * * 1");
    expect(toCron(calendarOf(schedule({ interval: "weekly", day: "friday", time: "18:05" })))).toBe("5 18 * * 5");
    expect(
      toCron(calendarOf(schedule({ interval: "weekly", day: ["thursday", "monday", "tuesday", "wednesday"] }))),
    ).toBe("17 6 * * 1-4");
  });

  it("runs monthly on the 1st, and cron as written", () => {
    expect(toCron(calendarOf(schedule({ interval: "monthly", time: "09:30" })))).toBe("30 9 1 * *");
    expect(toCron(calendarOf(schedule({ interval: "cron", cronjob: "0 8 * * mon-fri" })))).toBe("0 8 * * 1-5");
  });
});

describe("parseCron", () => {
  it("reads lists, ranges, steps and names", () => {
    expect(parseCron("*/15 9-17/4 1,15 jan,JUL sun,7")).toEqual({
      minute: [0, 15, 30, 45],
      hour: [9, 13, 17],
      dayOfMonth: [1, 15],
      month: [1, 7],
      weekday: [0],
    });
    expect(parseCron("5/20 * * * *").minute).toEqual([5, 25, 45]);
    expect(parseCron("0 0 * * */2").weekday).toEqual([0, 2, 4, 6]);
  });

  it.each([
    ["@daily", "must have 5 fields"],
    ["0 6 * *", "must have 5 fields"],
    ["60 6 * * *", "out of range for the minute field"],
    ["0 6 0 * *", "out of range for the day-of-month field"],
    ["0 6 * * 8", "out of range for the day-of-week field"],
    ["0 6 L * *", "out of range"],
    ["0 6 * * 1#2", "not valid cron syntax"],
    ["0 6-2 * * *", "backwards range"],
    ["*/0 6 * * *", "zero step"],
    ["*-5 6 * * *", "not valid"],
  ])("rejects %s", (expr, message) => {
    expect(() => parseCron(expr)).toThrow(CalendarError);
    expect(() => parseCron(expr)).toThrow(message);
  });
});

describe("toCron", () => {
  it("writes runs of three or more as ranges", () => {
    const cal: Calendar = { minute: [0, 1, 5, 6, 7], hour: "*", dayOfMonth: "*", month: [3], weekday: "*" };
    expect(toCron(cal)).toBe("0,1,5-7 * * 3 *");
  });
});

describe("convertZone", () => {
  const weekly = parseCron("17 6 * * 1");

  it("moves Monday 06:17 in Tokyo to Sunday 21:17 UTC", () => {
    const { calendar, warnings } = convertZone(weekly, "Asia/Tokyo", "UTC", NOW);
    expect(toCron(calendar)).toBe("17 21 * * 0");
    expect(warnings).toEqual([]);
  });

  it("moves forward across midnight and wraps Saturday to Sunday", () => {
    const { calendar } = convertZone(parseCron("30 22 * * 6"), "UTC", "Asia/Kolkata", NOW);
    expect(toCron(calendar)).toBe("0 4 * * 0");
  });

  it("leaves the calendar alone in the same zone or at the same offset", () => {
    expect(convertZone(weekly, "Asia/Tokyo", "Asia/Tokyo", NOW).calendar).toBe(weekly);
    expect(convertZone(weekly, "Asia/Tokyo", "Asia/Seoul", NOW).calendar).toEqual(weekly);
  });

  it("keeps every day as every day, and shifts each hour of a list", () => {
    expect(toCron(convertZone(parseCron("0 8,20 * * *"), "Asia/Tokyo", "UTC", NOW).calendar)).toBe("0 11,23 * * *");
    expect(toCron(convertZone(parseCron("*/30 * * * *"), "Asia/Kolkata", "UTC", NOW).calendar)).toBe("0,30 * * * *");
  });

  it("refuses moves that do not stay one calendar", () => {
    // 1st of the month at 06:17 in Tokyo is the last day of the previous month in UTC.
    expect(() => convertZone(parseCron("17 6 1 * *"), "Asia/Tokyo", "UTC", NOW)).toThrow(
      "another day of the month); set schedule.timezone to UTC",
    );
    // 06:00 in Tokyo is Sunday in UTC, 10:00 is still Monday.
    expect(() => convertZone(parseCron("0 6,10 * * 1"), "Asia/Tokyo", "UTC", NOW)).toThrow(
      "some runs would move to another day",
    );
    expect(() => convertZone(parseCron("0,45 6 * * *"), "Asia/Kolkata", "UTC", NOW)).toThrow(
      "do not stay one set of hours and minutes",
    );
  });

  it("warns when daylight saving time changes the offset between the zones", () => {
    const { calendar, warnings } = convertZone(weekly, "America/New_York", "UTC", NOW);
    expect(toCron(calendar)).toBe("17 10 * * 1"); // EDT on Oct 28
    expect(warnings).toEqual([
      "the offset between America/New_York and UTC changes with daylight saving time, so runs move by 1 hour for part of the year; install again after the change, or set schedule.timezone to UTC",
    ]);
  });
});

describe("nextRuns", () => {
  it("lists the next runs on the calendar's clock", () => {
    const runs = nextRuns(parseCron("17 6 * * 1,4"), "Asia/Tokyo", NOW, 3);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-10-28T21:17:00.000Z", // Thu 06:17 JST
      "2026-11-01T21:17:00.000Z", // Mon
      "2026-11-04T21:17:00.000Z", // Thu
    ]);
  });

  it("skips a run at the current minute and follows cron's either-day rule", () => {
    const at = new Date("2026-10-28T06:17:00Z");
    expect(nextRuns(parseCron("17 6 * * *"), "UTC", at, 1)[0]?.toISOString()).toBe("2026-10-29T06:17:00.000Z");
    // The 1st, or any Friday.
    const either = nextRuns(parseCron("0 0 1 * 5"), "UTC", NOW, 3).map((d) => d.toISOString().slice(0, 10));
    expect(either).toEqual(["2026-10-30", "2026-11-01", "2026-11-06"]);
  });

  it("finds rare days and returns none for impossible ones", () => {
    expect(nextRuns(parseCron("0 0 29 2 *"), "UTC", NOW, 1)[0]?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(nextRuns(parseCron("0 0 31 2 *"), "UTC", NOW, 1)).toEqual([]);
  });
});

describe("offsetMinutes and describeSchedule", () => {
  it("reads offsets including non-hour ones", () => {
    expect(offsetMinutes("Asia/Tokyo", NOW)).toBe(540);
    expect(offsetMinutes("Asia/Kathmandu", NOW)).toBe(345);
    expect(offsetMinutes("America/New_York", NOW)).toBe(-240);
    expect(offsetMinutes("UTC", NOW)).toBe(0);
  });

  it("describes each interval", () => {
    expect(describeSchedule(schedule({}), "UTC")).toBe("daily at 06:17 (UTC)");
    expect(describeSchedule(schedule({ interval: "weekly", day: ["monday", "wednesday", "friday"] }), "UTC")).toBe(
      "weekly on Monday, Wednesday and Friday at 06:17 (UTC)",
    );
    expect(describeSchedule(schedule({ interval: "monthly" }), "UTC")).toBe("monthly on the 1st at 06:17 (UTC)");
    expect(describeSchedule(schedule({ interval: "cron", cronjob: "0 8 * * 1-5" }), "UTC")).toBe(
      'cron "0 8 * * 1-5" (UTC)',
    );
  });
});
