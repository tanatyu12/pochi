import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLog, log, redact, resetLog } from "../../src/util/log.js";

afterEach(() => {
  resetLog();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("redact", () => {
  it.each([
    ["https://hooks.slack.com/services/T0/B0/abcDEF123", "https://hooks.slack.com/***"],
    ["url=https://hooks.slack.com/triggers/E0/1/xyz end", "url=https://hooks.slack.com/*** end"],
    ["key tvly-dev-AbC123_x", "key tvly-***"],
    ["Bearer sk-ant-api03-AbC_d-ef", "Bearer sk-ant-***"],
    ["Bearer ghp_AbC123xyz", "Bearer ghp_***"],
    ["token github_pat_11AbC_dEf", "token github_pat_***"],
    ["key sk-proj-AbC_123-xyz", "key sk-proj-***"],
    ["key sk-svcacct-AbC123", "key sk-svcacct-***"],
    ["key sk-AbCdEfGhIjKlMnOpQrStUvWx", "key sk-***"],
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

  it("masks secret env values that appear percent-encoded", () => {
    vi.stubEnv("TAVILY_API_KEY", "abc+def/ghi=");
    expect(redact("GET https://api.test/?key=abc%2Bdef%2Fghi%3D failed")).toBe("GET https://api.test/?key=*** failed");
  });

  it.each(["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"])(
    "masks the value of %s, which claude's or codex's stderr may carry",
    (name) => {
      vi.stubEnv(name, "opaque-token-98765");
      expect(redact("401 for opaque-token-98765")).toBe("401 for ***");
    },
  );

  it("masks secrets a host passes in, until the log is reset", () => {
    configureLog({ secrets: ["host-secret-123456"] });
    expect(redact("x host-secret-123456 y")).toBe("x *** y");
    resetLog();
    expect(redact("x host-secret-123456 y")).toBe("x host-secret-123456 y");
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

  it("keeps the writer when only the level changes, and the level when only the writer changes", () => {
    const lines: string[] = [];
    configureLog({ write: (s) => lines.push(s) });
    configureLog({ level: "verbose" });
    log.debug("first");
    configureLog({ write: (s) => lines.push(s.toUpperCase()) });
    log.debug("second");
    expect(lines).toEqual(["pochi: debug: first\n", "POCHI: DEBUG: SECOND\n"]);
  });

  it("puts back the previous level and writer when the returned function is called", () => {
    const lines = capture("normal");
    const restore = configureLog({ level: "quiet", write: (s) => lines.push(`other ${s}`) });
    log.info("hidden");
    restore();
    log.info("shown");
    expect(lines).toEqual(["pochi: info: shown\n"]);
  });

  it("drops control characters from messages and errors, keeping newlines", () => {
    const lines = capture("verbose");
    log.debug("reason: \u001b]0;title\u0007ok\u009b2J\nnext", new Error("bad\u001b[31m"));
    expect(lines).toEqual(["pochi: debug: reason: ]0;titleok2J\nnext: bad[31m\n"]);
  });

  it("writes to stderr, never stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    log.error("boom");
    expect(stderr).toHaveBeenCalledWith("pochi: error: boom\n");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("marks the severity instead of naming it on a color terminal", () => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("POCHI_PLAIN", "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const wasTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      log.info("collected 3 items from tvly-secret");
    } finally {
      process.stderr.isTTY = wasTTY;
    }
    expect(stderr).toHaveBeenCalledWith("  \x1b[38;5;183m›\x1b[0m collected 3 items from tvly-***\n");
  });
});
