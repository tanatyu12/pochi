import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RssFeed, Sources } from "../../src/config/schema.js";
import { collectAll, fetchSource, stateKeys } from "../../src/sources/index.js";
import { urlKey } from "../../src/util/hash.js";
import { HttpError } from "../../src/util/http.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { mockFetch, reply, type Reply } from "../helpers/mockFetch.js";

const SEARCH = "https://api.tavily.com/search";
const KEY = "tvly-test-0123456789abcdef";
const defaults = { itemsPerFeed: 3, maxContentChars: 2000 };

const feedUrl = (id: string) => `https://${id}.example.com/feed.xml`;

function rss(...links: string[]): Reply {
  const items = links.map((link) => `<item><title>${link}</title><link>${link}</link></item>`).join("");
  return reply.text(`<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`, {
    headers: { "content-type": "application/rss+xml" },
  });
}

function tavily(...urls: string[]): Reply {
  return reply.json({ results: urls.map((url) => ({ title: url, url, content: "c" })) });
}

const rssFeed = (id: string): RssFeed => ({ id, type: "rss", name: `Feed ${id}`, url: feedUrl(id) });

function config(feedIds: string[], queryIds: string[] = []): Sources {
  return {
    version: 1,
    defaults,
    feeds: feedIds.map(rssFeed),
    queries: queryIds.map((id) => ({ id, query: `query ${id}`, topic: "general" as const, maxResults: 5 })),
  };
}

let logged: string[];

beforeEach(() => {
  logged = [];
  configureLog({ level: "verbose", write: (s) => logged.push(s) });
  vi.stubEnv("TAVILY_API_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetLog();
});

describe("collectAll", () => {
  it("keeps going when one of three sources fails", async () => {
    mockFetch({
      [feedUrl("a")]: rss("https://a.example.com/1"),
      [feedUrl("b")]: reply.status(404),
      [feedUrl("c")]: rss("https://c.example.com/1"),
    });
    const result = await collectAll(config(["a", "b", "c"]));

    expect(result.items.map((i) => i.url)).toEqual(["https://a.example.com/1", "https://c.example.com/1"]);
    expect(result.attempted).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ sourceId: "b", sourceName: "Feed b", kind: "rss" });
    expect(result.failures[0]!.error).toBeInstanceOf(HttpError);
    expect(logged.filter((l) => l.includes("warn: source b failed"))).toHaveLength(1);
  });

  it("records every failure without throwing when all sources fail", async () => {
    mockFetch({
      [feedUrl("a")]: reply.text("not a feed"),
      [feedUrl("b")]: reply.status(403),
    });
    const result = await collectAll(config(["a", "b"]));

    expect(result.items).toEqual([]);
    expect(result.attempted).toBe(2);
    expect(result.failures.map((f) => f.sourceId)).toEqual(["a", "b"]);
  });

  it("drops an item another source already returned under the same id", async () => {
    // Tavily ids leave out the query, so two queries finding one page give the same id.
    mockFetch({ [SEARCH]: tavily("https://news.example.com/x", "https://news.example.com/y") });
    const result = await collectAll(config([], ["q1", "q2"]));

    expect(result.items.map((i) => [i.sourceId, i.url])).toEqual([
      ["q1", "https://news.example.com/x"],
      ["q1", "https://news.example.com/y"],
    ]);
  });

  it("drops an item whose normalized URL another source already returned, keeping the earlier source", async () => {
    mockFetch({
      [feedUrl("a")]: rss("https://news.example.com/x"),
      [SEARCH]: tavily("https://NEWS.example.com/x/?utm_source=tavily#top", "https://news.example.com/z"),
    });
    const result = await collectAll(config(["a"], ["q1"]));

    expect(result.items.map((i) => [i.kind, i.url])).toEqual([
      ["rss", "https://news.example.com/x"],
      ["tavily", "https://news.example.com/z"],
    ]);
  });

  it("keys the kept item by the URL the dropped copy shares, so the state file covers both", async () => {
    mockFetch({
      [feedUrl("a")]: rss("https://news.example.com/x"),
      [SEARCH]: tavily("https://news.example.com/x?utm_source=tavily"),
    });
    const [kept] = (await collectAll(config(["a"], ["q1"]))).items;

    // A later run where only Tavily returns the page finds this key in the state file.
    const [later] = (await collectAll(config([], ["q1"]))).items;
    expect(later!.kind).toBe("tavily");
    expect(later!.urlKey).toBe(urlKey("https://news.example.com/x"));
    expect(stateKeys(kept!)).toContain(later!.urlKey);
    expect(stateKeys(kept!)).toEqual([kept!.id, later!.urlKey]);
  });

  it("does not call Tavily without a key, and does not count the queries as attempted", async () => {
    vi.stubEnv("TAVILY_API_KEY", undefined);
    // No route for the search endpoint: a request to it would throw.
    const mock = mockFetch({ [feedUrl("a")]: rss("https://a.example.com/1") });
    const result = await collectAll(config(["a"], ["q1", "q2"]));

    expect(mock.callsTo(SEARCH)).toHaveLength(0);
    expect(result.items).toHaveLength(1);
    expect(result.attempted).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual(["q1", "q2"]);
    expect(logged.filter((l) => l.includes("TAVILY_API_KEY is not set; skipping 2 queries"))).toHaveLength(1);
  });

  it("searches Tavily when the key is set", async () => {
    const mock = mockFetch({ [SEARCH]: tavily("https://news.example.com/x") });
    const result = await collectAll(config([], ["q1"]));

    expect(mock.callsTo(SEARCH)).toHaveLength(1);
    expect(result.items.map((i) => i.sourceId)).toEqual(["q1"]);
    expect(result.attempted).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it("fetches at most four sources at a time and returns them in config order", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const release = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    const deferred =
      (id: string): Reply =>
      async (req, signal) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => release.set(id, resolve));
        active--;
        return rss(`https://${id}.example.com/1`)(req, signal);
      };
    mockFetch(Object.fromEntries(ids.map((id) => [feedUrl(id), deferred(id)])));

    const pending = collectAll(config(ids));
    await vi.waitFor(() => expect(release.size).toBe(4));
    expect([...release.keys()]).toEqual(["a", "b", "c", "d"]);

    // Finishing a later source first frees a slot for the fifth.
    release.get("d")!();
    await vi.waitFor(() => expect(release.has("e")).toBe(true));
    expect(release.has("f")).toBe(false);

    for (const id of ["c", "b", "e", "a"]) release.get(id)!();
    await vi.waitFor(() => expect(release.has("f")).toBe(true));
    release.get("f")!();

    const result = await pending;
    expect(peak).toBe(4);
    expect(result.items.map((i) => i.sourceId)).toEqual(ids);
  });

  it("rethrows an abort instead of recording it as failures", async () => {
    const controller = new AbortController();
    mockFetch({
      [feedUrl("a")]: (_req, signal) => {
        const hang = reply.hang()(_req, signal);
        controller.abort(new Error("interrupted"));
        return hang;
      },
    });

    await expect(collectAll(config(["a"]), { signal: controller.signal })).rejects.toThrow("interrupted");
    expect(logged.filter((l) => l.includes("warn:"))).toEqual([]);
  });
});

describe("fetchSource", () => {
  it("dispatches each kind to its fetcher", async () => {
    const releases = "https://api.github.com/repos/vercel/next.js/releases?per_page=100";
    const mock = mockFetch({
      [feedUrl("a")]: rss("https://a.example.com/1"),
      [releases]: reply.json([]),
      [SEARCH]: tavily("https://news.example.com/x"),
    });
    const rssItems = await fetchSource({ kind: "rss", feed: rssFeed("a") }, defaults);
    expect(rssItems.map((i) => i.kind)).toEqual(["rss"]);
    await fetchSource(
      {
        kind: "github",
        feed: { id: "next", type: "github", name: "Next.js", repo: "vercel/next.js", feed: "releases", includePrereleases: false },
      },
      defaults,
    );
    expect(mock.callsTo(releases)).toHaveLength(1);
    const tavilyItems = await fetchSource({ kind: "tavily", query: config([], ["q1"]).queries[0]! }, defaults);
    expect(tavilyItems.map((i) => i.kind)).toEqual(["tavily"]);
  });
});
