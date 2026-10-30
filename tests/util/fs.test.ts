import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isEnoent } from "../../src/util/fs.js";

describe("isEnoent", () => {
  it("does tell a missing file from any other failure", async () => {
    const missing = await readFile("/nonexistent/pochi-test").catch((err: unknown) => err);
    expect(isEnoent(missing)).toBe(true);
    expect(isEnoent(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(isEnoent(new Error("x"))).toBe(false);
    expect(isEnoent(undefined)).toBe(false);
    expect(isEnoent("ENOENT")).toBe(false);
  });
});
