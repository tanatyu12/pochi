import { afterEach, describe, expect, it, vi } from "vitest";
import { addDays, daysBetween, parseDate, sleep, toIsoDate, toIsoSeconds } from "../../src/util/time.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    const p = sleep(100).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it("rejects with the abort reason", async () => {
    const controller = new AbortController();
    const p = sleep(10_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });

  it("rejects at once when already aborted", async () => {
    await expect(sleep(10, AbortSignal.abort(new Error("early")))).rejects.toThrow("early");
  });
});

describe("dates", () => {
  const d = new Date("2026-10-25T22:17:03.456Z");

  it("formats in UTC", () => {
    expect(toIsoDate(d)).toBe("2026-10-25");
    expect(toIsoSeconds(d)).toBe("2026-10-25T22:17:03Z");
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("counts days between dates", () => {
    expect(daysBetween("2026-10-20", "2026-10-25")).toBe(5);
    expect(daysBetween("2026-10-25", "2026-10-20")).toBe(-5);
    expect(daysBetween("2026-12-25", "2027-01-08")).toBe(14);
  });

  it("rejects malformed dates", () => {
    expect(() => addDays("2026/10/25", 1)).toThrow(RangeError);
    expect(() => daysBetween("x", "2026-10-25")).toThrow(RangeError);
  });

  it.each([
    ["2026-10-25T22:17:03Z", "2026-10-25T22:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 GMT", "2026-10-25T22:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 +0900", "2026-10-25T13:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 EST", "2026-10-26T03:17:03.000Z"],
    ["25 Oct 2026 22:17 GMT", "2026-10-25T22:17:00.000Z"],
    ["2026-10-25", "2026-10-25T00:00:00.000Z"],
    ["2026-10-25T22:17:03+09:00", "2026-10-25T13:17:03.000Z"],
    ["2028-02-29T00:00:00Z", "2028-02-29T00:00:00.000Z"],
    ["2026-10-25T22:17:03+0900", "2026-10-25T13:17:03.000Z"],
    ["2026-10-25T22:17:03.5-0530", "2026-10-26T03:47:03.500Z"],
    ["Sun, 25 Oct 2026 22:17:03 JST", "2026-10-25T13:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 jst", "2026-10-25T13:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 KST", "2026-10-25T13:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 CEST", "2026-10-25T20:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 IST", "2026-10-25T16:47:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 AEDT", "2026-10-25T11:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 CST", "2026-10-26T04:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 UT", "2026-10-25T22:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 +09:00", "2026-10-25T13:17:03.000Z"],
    ["Sun, 25 Oct 2026 22:17:03 -0330", "2026-10-26T01:47:03.000Z"],
    ["Sun, 25 Oct 26 22:17:03 GMT", "2026-10-25T22:17:03.000Z"],
    ["1 Jan 99 00:00 GMT", "1999-01-01T00:00:00.000Z"],
    ["1 Jan 49 00:00 GMT", "2049-01-01T00:00:00.000Z"],
  ])("parses %s", (input, expected) => {
    expect(parseDate(input)?.toISOString()).toBe(expected);
  });

  it("reads an RFC 2822 date without a zone as local time, as V8 does", () => {
    expect(parseDate("25 Oct 2026 22:17:03")?.getTime()).toBe(new Date(2026, 9, 25, 22, 17, 3).getTime());
  });

  it.each([
    undefined,
    "",
    "not a date",
    "1",
    "Version 2",
    "2026-02-30",
    "2026-13-01",
    "31 Apr 2026 10:00 GMT",
    "29 Feb 26 10:00 GMT",
    "25 Oct 2026 10:00 XYZ",
    "25 Oct 2026 24:00 GMT",
    "25 Oct 2026 10:60 GMT",
    "25 Oct 2026 10:00 +0960",
    "25 Oct 202 10:00 GMT",
    "2026-10-25T25:00:00Z",
    "2026-10-25T10:00:00+09",
  ])("returns undefined for %j", (input) => {
    expect(parseDate(input)).toBeUndefined();
  });
});
