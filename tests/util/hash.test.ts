import { describe, expect, it } from "vitest";
import { itemId, normalizeUrl, sha256Hex } from "../../src/util/hash.js";

describe("sha256Hex", () => {
  it("hashes UTF-8 text", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("itemId", () => {
  it("is 32 hex characters and stable", () => {
    expect(itemId("nextjs", "v15.0.0")).toMatch(/^[0-9a-f]{32}$/);
    expect(itemId("nextjs", "v15.0.0")).toBe(itemId("nextjs", "v15.0.0"));
  });

  it("does not collide when parts shift", () => {
    expect(itemId("ab", "c")).not.toBe(itemId("a", "bc"));
  });
});

describe("normalizeUrl", () => {
  it.each([
    ["https://Example.COM/Post", "https://example.com/Post"],
    ["https://example.com/post#comments", "https://example.com/post"],
    ["https://example.com/post/", "https://example.com/post"],
    ["https://example.com/", "https://example.com/"],
    ["https://example.com:443/a", "https://example.com/a"],
    ["https://example.com/a?utm_source=x&utm_Medium=y&id=1", "https://example.com/a?id=1"],
    ["https://example.com/a?fbclid=1&gclid=2", "https://example.com/a"],
    ["https://example.com/a?page=2&utm_campaign=z", "https://example.com/a?page=2"],
    ["  https://example.com/a  ", "https://example.com/a"],
    ["javascript:alert(1)", undefined],
    ["mailto:a@example.com", undefined],
    ["not a url", undefined],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it("resolves relative URLs against a base", () => {
    expect(normalizeUrl("../post/", "https://example.com/blog/feed.xml")).toBe("https://example.com/post");
    expect(normalizeUrl("/a", "https://example.com/blog/")).toBe("https://example.com/a");
  });
});
