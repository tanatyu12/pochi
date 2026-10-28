import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryConfig } from "../../src/config/schema.js";
import { FeedParseError } from "../../src/sources/rss.js";
import { fetchTavilyItems, tavilyApiKey } from "../../src/sources/tavily.js";
import { itemId, urlKey } from "../../src/util/hash.js";
import { HttpError } from "../../src/util/http.js";
import { resetLog } from "../../src/util/log.js";
import { mockFetch, reply } from "../helpers/mockFetch.js";

const SEARCH = "https://api.tavily.com/search";
const KEY = "tvly-test-0123456789abcdef";
const fixture = JSON.parse(readFileSync(new URL("../fixtures/tavily/search.json", import.meta.url), "utf8"));

const query: QueryConfig = {
  id: "qwen-news",
  query: "Qwen model release",
  topic: "news",
  maxResults: 5,
  requireDate: false,
};
const defaults = { itemsPerFeed: 3, maxContentChars: 2000 };

beforeEach(() => {
  vi.stubEnv("TAVILY_API_KEY", KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetLog();
});

describe("tavilyApiKey", () => {
  it("is undefined when unset or blank", () => {
    vi.stubEnv("TAVILY_API_KEY", undefined);
    expect(tavilyApiKey()).toBeUndefined();
    vi.stubEnv("TAVILY_API_KEY", "  ");
    expect(tavilyApiKey()).toBeUndefined();
    vi.stubEnv("TAVILY_API_KEY", ` ${KEY} `);
    expect(tavilyApiKey()).toBe(KEY);
  });
});

describe("fetchTavilyItems", () => {
  it("posts the query with Bearer auth, a one-week range and basic depth", async () => {
    const mock = mockFetch({ [SEARCH]: reply.json(fixture) });
    await fetchTavilyItems(query, defaults);

    expect(mock.calls).toHaveLength(1);
    const req = mock.calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("user-agent")).toMatch(/^pochi\//);
    expect(JSON.parse(req.body!)).toEqual({
      query: "Qwen model release",
      topic: "news",
      search_depth: "basic",
      time_range: "week",
      include_published_date: true,
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    });
  });

  it("sends the configured topic and maxResults", async () => {
    const mock = mockFetch({ [SEARCH]: reply.json({ results: [] }) });
    await fetchTavilyItems({ ...query, topic: "general", maxResults: 12 }, defaults);
    const body = JSON.parse(mock.calls[0]!.body!);
    expect(body).toMatchObject({ topic: "general", max_results: 12 });
    expect(body).not.toHaveProperty("days");
  });

  it("asks Tavily to drop undated results only with requireDate", async () => {
    const mock = mockFetch({ [SEARCH]: reply.json({ results: [] }) });
    await fetchTavilyItems(query, defaults);
    await fetchTavilyItems({ ...query, requireDate: true }, defaults);
    expect(JSON.parse(mock.calls[0]!.body!)).not.toHaveProperty("filter_by_published_date");
    expect(JSON.parse(mock.calls[1]!.body!)).toMatchObject({ include_published_date: true, filter_by_published_date: true });
  });

  it.each([undefined, "", "   "])("does not search without a key (%j)", async (value) => {
    vi.stubEnv("TAVILY_API_KEY", value);
    const mock = mockFetch({});
    expect(await fetchTavilyItems(query, defaults)).toEqual([]);
    expect(mock.calls).toHaveLength(0);
  });

  it("maps results to items in relevance order, dropping duplicates and non-http URLs", async () => {
    mockFetch({ [SEARCH]: reply.json(fixture) });
    const items = await fetchTavilyItems(query, defaults);

    expect(items.map((i) => i.url)).toEqual([
      "https://example.com/news/qwen-4?utm_source=tavily",
      "https://blog.example.org/qwen-4-benchmarks/",
      "https://forum.example.net/t/qwen-4",
    ]);
    expect(items[0]).toEqual({
      id: itemId("tavily", "https://example.com/news/qwen-4"),
      sourceId: "qwen-news",
      sourceName: "Qwen model release",
      kind: "tavily",
      title: "Qwen 4 released with 1M context",
      url: "https://example.com/news/qwen-4?utm_source=tavily",
      urlKey: urlKey("https://example.com/news/qwen-4"),
      publishedAt: "2026-10-20T08:00:00.000Z",
      content: "Alibaba released Qwen 4 today.",
    });
    expect(items[1]!.publishedAt).toBeUndefined();
    // An empty title falls back to the URL.
    expect(items[2]!.title).toBe("https://forum.example.net/t/qwen-4");
  });

  it("skips results without a URL and keeps the rest", async () => {
    const results = [{ title: "no url", url: null }, { title: "missing url" }, ...fixture.results];
    mockFetch({ [SEARCH]: reply.json({ results }) });
    expect(await fetchTavilyItems(query, defaults)).toHaveLength(3);
  });

  it("gives the same page the same id under different queries", async () => {
    mockFetch({ [SEARCH]: reply.json(fixture) });
    const [a] = await fetchTavilyItems(query, defaults);
    const [b] = await fetchTavilyItems({ ...query, id: "other" }, defaults);
    expect(a!.id).toBe(b!.id);
    expect(b!.sourceId).toBe("other");
  });

  it("cuts content to maxContentChars without splitting emoji or CJK", async () => {
    mockFetch({ [SEARCH]: reply.json(fixture) });
    const items = await fetchTavilyItems(query, { ...defaults, maxContentChars: 20 });
    const content = items[1]!.content;
    expect(Array.from(content).length).toBeLessThanOrEqual(20);
    expect(content.startsWith("Qwen 4 では")).toBe(true);
    expect(content).not.toMatch(/�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("fails on 401 without retrying and without the key in the message", async () => {
    const mock = mockFetch({ [SEARCH]: reply.status(401) });
    const err = await fetchTavilyItems(query, defaults).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect((err as HttpError).message).toContain("TAVILY_API_KEY");
    expect((err as HttpError).message).not.toContain(KEY);
    expect(mock.calls).toHaveLength(1);
  });

  it("retries a 429 once", async () => {
    const mock = mockFetch({ [SEARCH]: [reply.status(429, { "retry-after": "0" }), reply.json(fixture)] });
    expect(await fetchTavilyItems(query, defaults)).toHaveLength(3);
    expect(mock.calls).toHaveLength(2);
  });

  it("gives up after a second 429", async () => {
    const mock = mockFetch({
      [SEARCH]: [reply.status(429, { "retry-after": "0" }), reply.status(429, { "retry-after": "0" })],
    });
    await expect(fetchTavilyItems(query, defaults)).rejects.toMatchObject({ name: "HttpError", status: 429 });
    expect(mock.calls).toHaveLength(2);
  });

  it("does not retry a 5xx, which may already have been billed", async () => {
    const mock = mockFetch({ [SEARCH]: [reply.status(502), reply.json(fixture)] });
    await expect(fetchTavilyItems(query, defaults)).rejects.toMatchObject({ status: 502 });
    expect(mock.calls).toHaveLength(1);
  });

  it.each([
    ["not JSON", reply.text("<html>oops</html>")],
    ["no results", reply.json({ answer: "x" })],
  ])("throws FeedParseError on a response that is %s", async (_, r) => {
    mockFetch({ [SEARCH]: r });
    await expect(fetchTavilyItems(query, defaults)).rejects.toBeInstanceOf(FeedParseError);
  });

  it("passes a cancellation through", async () => {
    mockFetch({ [SEARCH]: reply.hang() });
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const pending = fetchTavilyItems(query, defaults, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
