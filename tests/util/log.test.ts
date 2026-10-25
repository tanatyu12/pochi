import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLog, log, redact } from "../../src/util/log.js";

afterEach(() => {
  configureLog({});
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("redact", () => {
  it.each([
    ["https://hooks.slack.com/services/T0/B0/abcDEF123", "https://hooks.slack.com/***"],
    ["url=https://hooks.slack.com/triggers/E0/1/xyz end", "url=https://hooks.slack.com/*** end"],
    ["key tvly-dev-AbC123_x", "key tvly-***"],
    ["Bearer sk-ant-api03-AbC_d-ef", "Bearer sk-ant-***"],
  ])("masks %s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("masks every occurrence", () => {
    expect(redact("tvly-a tvly-b sk-ant-c")).toBe("tvly-*** tvly-*** sk-ant-***");
  });

  it("masks secret env values whatever their format", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "custom-key-123456");
    expect(redact("auth custom-key-123456 failed")).toBe("auth *** failed");
  });

  it("ignores short env values", () => {
    vi.stubEnv("TAVILY_API_KEY", "abc");
    expect(redact("abc def")).toBe("abc def");
  });

  it("leaves unrelated text unchanged", () => {
    const text = "fetched https://example.com/feed (3 items) with sk-key and tvly";
    expect(redact(text)).toBe(text);
  });
});

describe("log", () => {
  function capture(level?: "quiet" | "normal" | "verbose"): string[] {
    const lines: string[] = [];
    configureLog({ level, write: (s) => lines.push(s) });
    return lines;
  }

  it("writes redacted lines with the severity", () => {
    const lines = capture();
    log.warn("source failed", new Error("401 for tvly-secret"));
    expect(lines).toEqual(["pochi: warn: source failed: 401 for tvly-***\n"]);
  });

  it.each([
    ["quiet", ["warn", "error"]],
    ["normal", ["info", "warn", "error"]],
    ["verbose", ["debug", "info", "warn", "error"]],
  ] as const)("filters by level %s", (level, expected) => {
    const lines = capture(level);
    log.debug("x");
    log.info("x");
    log.warn("x");
    log.error("x");
    expect(lines.map((l) => l.split(":")[1]?.trim())).toEqual(expected);
  });

  it("writes to stderr, never stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log.error("boom");
    expect(stderr).toHaveBeenCalledWith("pochi: error: boom\n");
    expect(stdout).not.toHaveBeenCalled();
  });
});
