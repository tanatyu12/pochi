import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverFeeds, findFeedLinks } from "../../src/sources/discover.js";
import { HttpError } from "../../src/util/http.js";
import { resetLog } from "../../src/util/log.js";
import { mockFetch, reply, type Route } from "../helpers/mockFetch.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/feeds/${name}`, import.meta.url), "utf8");
}

const html = (body: string) => reply.text(body, { headers: { "content-type": "text/html" } });
const rss = reply.text(fixture("rss2.xml"), { headers: { "content-type": "application/rss+xml" } });
const notFound = reply.status(404);
const page = (head: string) => `<!doctype html><html><head>${head}</head><body><p>Hi</p></body></html>`;

const PAGE = "https://blog.example/posts/";
const FALLBACKS = ["/feed", "/feed/", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml"].map(
  (p) => `https://blog.example${p}`,
);

afterEach(() => {
  vi.unstubAllGlobals();
  resetLog();
});

describe("findFeedLinks", () => {
  it.each([
    ["double quotes", `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`],
    ["any attribute order", `<link type="application/rss+xml" href="/feed.xml" rel="alternate">`],
    ["single quotes", `<link rel='alternate' type='application/rss+xml' href='/feed.xml'>`],
    ["unquoted values", `<link rel=alternate type=application/rss+xml href=/feed.xml>`],
    ["upper case", `<LINK REL="Alternate" TYPE="Application/RSS+XML" HREF="/feed.xml">`],
    ["several rel tokens", `<link rel="home alternate" type="application/rss+xml" href="/feed.xml">`],
    ["type parameters", `<link rel="alternate" type="application/rss+xml; charset=utf-8" href="/feed.xml">`],
    ["self-closing", `<link rel="alternate" type="application/rss+xml" href="/feed.xml"/>`],
    ["spaces around =", `<link rel = "alternate" type = "application/rss+xml" href = "/feed.xml" >`],
    ["line breaks", `<link\n  rel="alternate"\n  type="application/rss+xml"\n  href="/feed.xml"\n>`],
  ])("finds a link with %s", (_name, head) => {
    expect(findFeedLinks(page(head), PAGE)).toEqual([{ url: "https://blog.example/feed.xml" }]);
  });

  it.each([
    ["application/atom+xml", "https://blog.example/f"],
    ["application/feed+json", "https://blog.example/f"],
  ])("accepts %s", (type, url) => {
    expect(findFeedLinks(page(`<link rel="alternate" type="${type}" href="/f">`), PAGE)).toEqual([{ url }]);
  });

  it.each([
    ["/feed.xml", "https://blog.example/feed.xml"],
    ["feed.xml", "https://blog.example/posts/feed.xml"],
    ["../atom.xml", "https://blog.example/atom.xml"],
    ["//cdn.example/feed", "https://cdn.example/feed"],
    ["https://feeds.example/blog", "https://feeds.example/blog"],
    ["/feed?a=1&amp;b=2", "https://blog.example/feed?a=1&b=2"],
  ])("resolves %s against the page URL", (href, url) => {
    const head = `<link rel="alternate" type="application/rss+xml" href="${href}">`;
    expect(findFeedLinks(page(head), PAGE)).toEqual([{ url }]);
  });

  it("resolves against <base href>", () => {
    const head = `<base href="https://other.example/blog/"><link rel="alternate" type="application/rss+xml" href="feed.xml">`;
    expect(findFeedLinks(page(head), PAGE)).toEqual([{ url: "https://other.example/blog/feed.xml" }]);
  });

  it("resolves a relative <base href> against the page URL first", () => {
    const head = `<link rel="alternate" type="application/rss+xml" href="feed.xml"><BASE HREF='/blog/'>`;
    expect(findFeedLinks(page(head), PAGE)).toEqual([{ url: "https://blog.example/blog/feed.xml" }]);
  });

  it("ignores a <base> without a usable href", () => {
    const head = `<base target="_blank"><link rel="alternate" type="application/rss+xml" href="feed.xml">`;
    expect(findFeedLinks(page(head), PAGE)).toEqual([{ url: "https://blog.example/posts/feed.xml" }]);
  });

  it("keeps the title and document order, and drops repeats", () => {
    const head = [
      `<link rel="alternate" type="application/atom+xml" title="Atom &amp; more" href="/atom.xml">`,
      `<link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">`,
      `<link rel="alternate" type="application/rss+xml" title="Again" href="https://blog.example/atom.xml">`,
    ].join("\n");
    expect(findFeedLinks(page(head), PAGE)).toEqual([
      { url: "https://blog.example/atom.xml", title: "Atom & more" },
      { url: "https://blog.example/rss.xml", title: "RSS" },
    ]);
  });

  it.each([
    ["a stylesheet", `<link rel="stylesheet" type="text/css" href="/style.css">`],
    ["rel without alternate", `<link rel="feed" type="application/rss+xml" href="/feed.xml">`],
    ["rel that only contains the word", `<link rel="alternates" type="application/rss+xml" href="/feed.xml">`],
    ["a non-feed type", `<link rel="alternate" type="text/html" hreflang="ja" href="/ja/">`],
    ["no type", `<link rel="alternate" href="/feed.xml">`],
    ["no href", `<link rel="alternate" type="application/rss+xml">`],
    ["an empty href", `<link rel="alternate" type="application/rss+xml" href="">`],
    ["a javascript: href", `<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">`],
    ["a link inside a comment", `<!-- <link rel="alternate" type="application/rss+xml" href="/feed.xml"> -->`],
  ])("skips %s", (_name, head) => {
    expect(findFeedLinks(page(head), PAGE)).toEqual([]);
  });

  it("only looks at the head", () => {
    const doc = `<html><head><title>x</title></head><body><link rel="alternate" type="application/rss+xml" href="/feed.xml"></body></html>`;
    expect(findFeedLinks(doc, PAGE)).toEqual([]);
  });

  it("stops at <body> when </head> is missing, and reads everything when both are", () => {
    const link = `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`;
    expect(findFeedLinks(`<title>x</title><body>${link}`, PAGE)).toEqual([]);
    expect(findFeedLinks(`<title>x</title>${link}`, PAGE)).toEqual([{ url: "https://blog.example/feed.xml" }]);
  });
});

describe("discoverFeeds", () => {
  it.each([
    ["RSS", "rss2.xml"],
    ["Atom", "atom.xml"],
    ["JSON Feed", "feed.json"],
  ])("returns the URL itself when it is a %s feed", async (_name, file) => {
    const url = "https://blog.example/feed";
    const mock = mockFetch({ [url]: reply.text(fixture(file)) });
    await expect(discoverFeeds(url)).resolves.toEqual([{ url }]);
    expect(mock.calls).toHaveLength(1);
  });

  it("returns a feed URL after redirects", async () => {
    mockFetch({ "http://blog.example/feed": reply.redirect("https://blog.example/feed/", fixture("rss2.xml")) });
    await expect(discoverFeeds("http://blog.example/feed")).resolves.toEqual([{ url: "https://blog.example/feed/" }]);
  });

  it("returns every advertised feed that parses, in document order", async () => {
    const head = [
      `<link rel="alternate" type="application/rss+xml" title="Posts" href="/posts.xml">`,
      `<link rel="alternate" type="application/atom+xml" title="Broken" href="/broken.xml">`,
      `<link rel="alternate" type="application/feed+json" title="JSON" href="/feed.json">`,
    ].join("");
    mockFetch({
      [PAGE]: html(page(head)),
      "https://blog.example/posts.xml": rss,
      "https://blog.example/broken.xml": reply.text(fixture("broken.xml")),
      "https://blog.example/feed.json": reply.text(fixture("feed.json")),
    });
    await expect(discoverFeeds(PAGE)).resolves.toEqual([
      { url: "https://blog.example/posts.xml", title: "Posts" },
      { url: "https://blog.example/feed.json", title: "JSON" },
    ]);
  });

  it("resolves links against the page URL after redirects", async () => {
    const head = `<link rel="alternate" type="application/rss+xml" href="feed.xml">`;
    mockFetch({
      "http://old.example/": reply.redirect("https://new.example/blog/", page(head)),
      "https://new.example/blog/feed.xml": rss,
    });
    await expect(discoverFeeds("http://old.example/")).resolves.toEqual([{ url: "https://new.example/blog/feed.xml" }]);
  });

  it("reports the feed URL after redirects and drops links that land on the same feed", async () => {
    const head = [
      `<link rel="alternate" type="application/rss+xml" href="/rss">`,
      `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`,
    ].join("");
    mockFetch({
      [PAGE]: html(page(head)),
      "https://blog.example/rss": reply.redirect("https://blog.example/feed.xml", fixture("rss2.xml")),
      "https://blog.example/feed.xml": rss,
    });
    await expect(discoverFeeds(PAGE)).resolves.toEqual([{ url: "https://blog.example/feed.xml" }]);
  });

  it("tries the common paths in order when the page has no feed link, stopping at the first feed", async () => {
    const mock = mockFetch({
      [PAGE]: reply.text(fixture("not-a-feed.html")),
      [FALLBACKS[0]!]: notFound,
      [FALLBACKS[1]!]: html(page("")),
      [FALLBACKS[2]!]: rss,
    });
    await expect(discoverFeeds(PAGE)).resolves.toEqual([{ url: FALLBACKS[2] }]);
    expect(mock.calls.map((c) => c.url)).toEqual([PAGE, ...FALLBACKS.slice(0, 3)]);
  });

  it("falls back to the common paths when every advertised feed fails", async () => {
    const head = [
      `<link rel="alternate" type="application/rss+xml" href="/gone.xml">`,
      `<link rel="alternate" type="application/rss+xml" href="/page.html">`,
    ].join("");
    mockFetch({
      [PAGE]: html(page(head)),
      "https://blog.example/gone.xml": notFound,
      "https://blog.example/page.html": html(page("")),
      [FALLBACKS[0]!]: rss,
    });
    await expect(discoverFeeds(PAGE)).resolves.toEqual([{ url: FALLBACKS[0] }]);
  });

  it("returns nothing after trying every common path", async () => {
    const routes: Record<string, Route> = { [PAGE]: html(page("<title>x</title>")) };
    for (const url of FALLBACKS) routes[url] = notFound;
    const mock = mockFetch(routes);
    await expect(discoverFeeds(PAGE)).resolves.toEqual([]);
    expect(mock.calls.map((c) => c.url)).toEqual([PAGE, ...FALLBACKS]);
  });

  it("resolves the common paths against the origin after redirects", async () => {
    const mock = mockFetch({
      "http://old.example/blog/": reply.redirect("https://new.example/blog/", page("")),
      "https://new.example/feed": rss,
    });
    await expect(discoverFeeds("http://old.example/blog/")).resolves.toEqual([{ url: "https://new.example/feed" }]);
    expect(mock.calls.map((c) => c.url)).toEqual(["http://old.example/blog/", "https://new.example/feed"]);
  });

  it("throws when the page itself cannot be fetched", async () => {
    mockFetch({ [PAGE]: notFound });
    const err = await discoverFeeds(PAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });

  it("checks at most four advertised feeds at a time and stops when the caller aborts", async () => {
    const hrefs = Array.from({ length: 6 }, (_, i) => `https://blog.example/f${i}.xml`);
    const head = hrefs.map((h) => `<link rel="alternate" type="application/rss+xml" href="${h}">`).join("");
    const routes: Record<string, Route> = { [PAGE]: html(page(head)) };
    for (const h of hrefs) routes[h] = reply.hang();
    const mock = mockFetch(routes);

    const controller = new AbortController();
    const result = discoverFeeds(PAGE, controller.signal).catch((e: unknown) => e);
    await vi.waitFor(() => expect(mock.calls).toHaveLength(5));
    await new Promise((r) => setTimeout(r, 20));
    expect(mock.calls).toHaveLength(5);

    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(result).resolves.toBe(reason);
  });
});
