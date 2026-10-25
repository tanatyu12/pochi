import { describe, expect, it } from "vitest";
import { ExitCode, PochiError, exitCodeOf } from "../src/errors.js";

describe("exitCodeOf", () => {
  it("returns the exit code carried by a PochiError", () => {
    expect(exitCodeOf(new PochiError("bad config", ExitCode.CONFIG))).toBe(2);
  });

  it("treats other errors and non-error values as internal errors", () => {
    expect(exitCodeOf(new Error("boom"))).toBe(1);
    expect(exitCodeOf("boom")).toBe(1);
    expect(exitCodeOf(undefined)).toBe(1);
  });
});

describe("PochiError", () => {
  it("keeps the cause and uses the subclass name", () => {
    class SampleError extends PochiError {}
    const cause = new Error("root");
    const err = new SampleError("wrapped", ExitCode.LLM, { cause });
    expect(err.name).toBe("SampleError");
    expect(err.cause).toBe(cause);
  });
});
