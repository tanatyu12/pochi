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
  ])("parses %s", (input, expected) => {
    expect(parseDate(input)?.toISOString()).toBe(expected);
  });

  it.each([undefined, "", "not a date"])("returns undefined for %j", (input) => {
    expect(parseDate(input)).toBeUndefined();
  });
});
