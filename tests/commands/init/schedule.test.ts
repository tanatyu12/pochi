import { describe, expect, it } from "vitest";
import { runsPerMonth } from "../../../src/commands/init/schedule.js";
import { ContextSchema } from "../../../src/config/schema.js";
import { CONTEXT } from "./fixtures.js";

describe("runsPerMonth", () => {
  const now = new Date("2026-10-29T03:30:00Z");
  it("counts the runs in the next 30 days at the schedule", () => {
    const schedule = (extra: object) => ContextSchema.parse({ ...CONTEXT, schedule: extra }).schedule;
    expect(runsPerMonth(schedule({ interval: "daily", timezone: "Asia/Tokyo" }), "UTC", now)).toBe(30);
    expect(runsPerMonth(schedule({ interval: "weekly", day: ["friday", "saturday"], timezone: "Asia/Tokyo" }), "UTC", now)).toBe(10);
    expect(runsPerMonth(schedule({ interval: "cron", cronjob: "* * * * *" }), "UTC", now)).toBe(1000);
  });
});
