import { describe, expect, it } from "vitest";
import { shellQuote, singleQuote } from "../../src/util/shell.js";

describe("singleQuote", () => {
  it("does quote every value, closing and reopening around a single quote", () => {
    expect(singleQuote("plain")).toBe("'plain'");
    expect(singleQuote("")).toBe("''");
    expect(singleQuote("it's $HOME")).toBe("'it'\\''s $HOME'");
  });
});

describe("shellQuote", () => {
  it("does leave plain paths as they are and quote the rest", () => {
    expect(shellQuote("config/prod.yml")).toBe("config/prod.yml");
    expect(shellQuote("my config")).toBe("'my config'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("$HOME")).toBe("'$HOME'");
  });
});
