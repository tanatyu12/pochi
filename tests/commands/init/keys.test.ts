import { describe, expect, it } from "vitest";
import {
  cleanQuery,
  cleanSuggestions,
  feedKey,
  keyOf,
  labelOf,
  newsKey,
  once,
  queryKey,
  repoKey,
} from "../../../src/commands/init/keys.js";

describe("keyOf", () => {
  it("treats a repository case-insensitively", () => {
    expect(keyOf({ id: "a", type: "github", name: "Vercel/Next.js", repo: "Vercel/Next.js" })).toBe(repoKey("vercel/next.js"));
  });

  it("compares feed URLs as the pipeline normalizes them", () => {
    const feed = { id: "a", type: "rss" as const, name: "x", url: "https://example.com/feed/?utm_source=x" };
    expect(keyOf(feed)).toBe(feedKey("https://example.com/feed"));
  });

  it("tells a news search from a web search for the same words", () => {
    const news = keyOf({ id: "a", type: "googlenews", query: "Qwen release" });
    const web = keyOf({ id: "b", query: "Qwen release" });
    expect(news).not.toBe(web);
    expect(web).toBe(queryKey("qwen  release"));
  });
});

describe("newsKey", () => {
  it("ignores case, spacing and the order of the sites", () => {
    expect(newsKey(" Qwen\tRelease ", ["b.com", "a.com"])).toBe(newsKey("qwen release", ["a.com", "b.com"]));
  });

  it("tells a search kept to sites from the same words anywhere", () => {
    expect(newsKey("qwen", ["a.com"])).not.toBe(newsKey("qwen"));
  });
});

describe("labelOf", () => {
  it("falls back to the query for a news search without a name", () => {
    expect(labelOf({ id: "a", type: "googlenews", query: "qwen" })).toBe("qwen");
    expect(labelOf({ id: "a", type: "googlenews", name: "Qwen news", query: "qwen" })).toBe("Qwen news");
    expect(labelOf({ id: "a", type: "github", name: "vercel/next.js", repo: "vercel/next.js" })).toBe("vercel/next.js");
  });
});

describe("cleanQuery", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(cleanQuery("  a\u0007b \n c  ")).toBe("ab c");
  });
});

describe("cleanSuggestions", () => {
  it("drops queries that clean to nothing and repeats in any case, keeping the first", () => {
    const cleaned = cleanSuggestions([
      { query: "Qwen  release", topic: "news", hint: "first" },
      { query: "\u0001", topic: "news" },
      { query: "qwen release", topic: "general", hint: "second" },
      { query: "Other", topic: "general" },
    ]);
    expect(cleaned).toEqual([
      { query: "Qwen release", topic: "news", hint: "first" },
      { query: "Other", topic: "general" },
    ]);
  });
});

describe("once", () => {
  it("is true only the first time a key is seen", () => {
    const seen = new Set<string>();
    expect([once(seen, "a"), once(seen, "b"), once(seen, "a")]).toEqual([true, true, false]);
  });
});
