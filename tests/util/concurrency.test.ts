import { describe, expect, it } from "vitest";
import { pLimit } from "../../src/util/concurrency.js";
import { sleep } from "../../src/util/time.js";

describe("pLimit", () => {
  it("never runs more than the limit at once", async () => {
    const limit = pLimit(3);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(5 + (i % 3));
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps going after a task fails", async () => {
    const limit = pLimit(1);
    const results = await Promise.allSettled([
      limit(async () => {
        throw new Error("boom");
      }),
      limit(() => {
        throw new Error("sync boom");
      }),
      limit(async () => "ok"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "fulfilled"]);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects concurrency %s", (n) => {
    expect(() => pLimit(n)).toThrow(RangeError);
  });
});
