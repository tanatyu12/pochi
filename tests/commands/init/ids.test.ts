import { describe, expect, it } from "vitest";
import { cutAtWord, queryIdFrom, slug, sourceIdFrom, uniqueId } from "../../../src/commands/init/ids.js";

describe("sourceIdFrom", () => {
  it.each([
    ["next.js", "next-js"],
    [".github", "github"],
    ["My_Repo", "my_repo"],
    ["日本語", "source"],
    ["a--", "a"],
  ])("%s -> %s", (raw, id) => {
    expect(sourceIdFrom(raw, new Set())).toBe(id);
  });

  it("appends a number until the id is free", () => {
    expect(sourceIdFrom("blog", new Set(["blog", "blog-2"]))).toBe("blog-3");
  });
});

describe("queryIdFrom", () => {
  it.each([
    ["Qwen model release", "qwen-model-release"],
    ["Breaking changes in the Next.js app router and server actions", "breaking-changes-in-the-next-js"],
    ["a".repeat(40), "a".repeat(32)],
  ])("%s -> %s", (query, id) => {
    expect(queryIdFrom(query, new Set())).toBe(id);
  });

  it("names a query with other characters by a hash that does not depend on order", () => {
    const id = queryIdFrom("Next.js リリース", new Set());
    expect(id).toMatch(/^query-[0-9a-f]{8}$/);
    expect(queryIdFrom("LLM 新モデル", new Set([id]))).not.toBe(id);
    expect(queryIdFrom("next.js リリース", new Set())).toBe(id);
    expect(queryIdFrom("!!!", new Set())).toMatch(/^query-[0-9a-f]{8}$/);
  });
});

describe("slug", () => {
  it.each([
    ["Next.js", "next-js"],
    ["  spaces  and--dashes ", "spaces-and--dashes"],
    ["_leading", "leading"],
    ["keep_underscore", "keep_underscore"],
    ["日本語", ""],
  ])("%s -> %s", (raw, slugged) => {
    expect(slug(raw)).toBe(slugged);
  });
});

describe("cutAtWord", () => {
  it("leaves an id within the limit as it is", () => {
    expect(cutAtWord("short-id", 32)).toBe("short-id");
  });

  it("cuts after the last whole word that fits", () => {
    expect(cutAtWord("alpha-beta-gamma", 12)).toBe("alpha-beta");
    // A word that ends right at the limit is kept whole.
    expect(cutAtWord("alpha-beta-gamma", 10)).toBe("alpha-beta");
  });

  it("cuts mid-word when one word is longer than the limit, leaving no separator at the end", () => {
    expect(cutAtWord("abcdefghij", 4)).toBe("abcd");
    expect(cutAtWord("abc_-defgh", 4)).toBe("abc");
  });
});

describe("uniqueId", () => {
  it("returns the base when it is free, and numbers it from 2 otherwise", () => {
    expect(uniqueId("blog", new Set())).toBe("blog");
    expect(uniqueId("blog", new Set(["blog"]))).toBe("blog-2");
    expect(uniqueId("blog", new Set(["blog", "blog-2", "blog-3"]))).toBe("blog-4");
  });
});
