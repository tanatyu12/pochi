import { describe, expect, it } from "vitest";
import { settle } from "../../src/util/settle.js";

describe("settle", () => {
  it("does resolve with the value or the reason, never rejecting", async () => {
    expect(await settle(Promise.resolve(1))).toEqual({ status: "fulfilled", value: 1 });
    const reason = new Error("no");
    expect(await settle(Promise.reject(reason))).toEqual({ status: "rejected", reason });
  });
});
