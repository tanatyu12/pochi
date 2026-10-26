import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverFeeds, findFeedLinks } from "../../src/sources/discover.js";
import { HttpError } from "../../src/util/http.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { mockFetch, reply, type Route } from "../helpers/mockFetch.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/feeds/${name}`, import.meta.url), "utf8");
}

const html = (body: string) => reply.text(body, { headers: { "content-type": "text/html" } });
const rss = reply.text(fixture("rss2.xml"), { headers: { "content-type": "application/rss+xml" } });
const notFound = reply.status(404);
const page = (head: string) => `<!doctype html><html><head>${head}</head><body><p>Hi</p></body></html>`;

const PAGE = "https://blog.example/posts/";
const FALLBACK_PATHS = ["feed", "feed/", "rss", "rss.xml", "atom.xml", "feed.xml", "index.xml"];
const FALLBACKS = FALLBACK_PATHS.map((p) => `${PAGE}${p}`);
// Answers at once and is not retried after the one 429 retry, so tests stay fast.
const busy = [reply.status(429, { "retry-after": "0" }), reply.status(429, { "retry-after": "0" })];

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
    ["application/rdf+xml", "https://blog.example/f"],
    ["application/x-rss+xml", "https://blog.example/f"],
    ["application/x-atom+xml", "https://blog.example/f"],
    ["text/xml", "https://blog.example/f"],
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

  it.each([
    ["</head>", `<script>const s = "</head>";</script>`],
    ["<body>", `<script type="module">document.write('<body>')</script>`],
    ["a <link>", `<script>x = '<link rel="alternate" type="application/rss+xml" href="/fake.xml">'</script>`],
    ["</head> in a style", `<style>/* </head> */</style>`],
  ])("ignores %s inside a script or style in the head", (_name, before) => {
    const link = `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`;
    expect(findFeedLinks(page(before + link), PAGE)).toEqual([{ url: "https://blog.example/feed.xml" }]);
  });

  it("keeps reading a tag past a > inside a quoted attribute", () => {
    const head = `<base href="/a>b/"><link rel="alternate" type="application/rss+xml" title="News > Tech" href="feed.xml">`;
    expect(findFeedLinks(page(head), PAGE)).toEqual([{ url: "https://blog.example/a%3Eb/feed.xml", title: "News > Tech" }]);
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

  it("resolves the common paths under the page path after redirects", async () => {
    const mock = mockFetch({
      "http://old.example/blog/": reply.redirect("https://new.example/blog/", page("")),
      "https://new.example/blog/feed": rss,
    });
    await expect(discoverFeeds("http://old.example/blog/")).resolves.toEqual([{ url: "https://new.example/blog/feed" }]);
    expect(mock.calls.map((c) => c.url)).toEqual(["http://old.example/blog/", "https://new.example/blog/feed"]);
  });

  it("does not probe the site root for a page under a path on a shared host", async () => {
    const user = "https://dev.example/someuser?tab=posts";
    const routes: Record<string, Route> = { [user]: html(page("")) };
    for (const p of FALLBACK_PATHS) routes[`https://dev.example/someuser/${p}`] = notFound;
    const mock = mockFetch(routes);
    await expect(discoverFeeds(user)).resolves.toEqual([]);
    expect(mock.calls.map((c) => c.url)).not.toContain("https://dev.example/feed");
    expect(mock.calls[1]!.url).toBe("https://dev.example/someuser/feed");
  });

  it("probes the root for a page at the root", async () => {
    mockFetch({ "https://blog.example/": html(page("")), "https://blog.example/feed": rss });
    await expect(discoverFeeds("https://blog.example/")).resolves.toEqual([{ url: "https://blog.example/feed" }]);
  });

  it("throws instead of probing the common paths when an advertised feed fails for a passing reason", async () => {
    const head = [
      `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`,
      `<link rel="alternate" type="application/rss+xml" href="/gone.xml">`,
    ].join("");
    const mock = mockFetch({
      [PAGE]: html(page(head)),
      "https://blog.example/feed.xml": busy,
      "https://blog.example/gone.xml": notFound,
    });
    await expect(discoverFeeds(PAGE)).rejects.toMatchObject({ name: "HttpError", status: 429 });
    expect(mock.calls.map((c) => c.url)).not.toContain(FALLBACKS[0]);
  });

  it("returns the feeds that worked and warns about one that failed for a passing reason", async () => {
    const head = [
      `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`,
      `<link rel="alternate" type="application/rss+xml" href="/busy.xml">`,
    ].join("");
    const out: string[] = [];
    configureLog({ write: (s) => out.push(s) });
    mockFetch({ [PAGE]: html(page(head)), "https://blog.example/feed.xml": rss, "https://blog.example/busy.xml": busy });
    await expect(discoverFeeds(PAGE)).resolves.toEqual([{ url: "https://blog.example/feed.xml" }]);
    expect(out.join("")).toContain("could not check an advertised feed: https://blog.example/busy.xml");
  });

  it("throws when a common path failed for a passing reason and none worked", async () => {
    const routes: Record<string, Route> = { [PAGE]: html(page("")) };
    for (const url of FALLBACKS) routes[url] = notFound;
    routes[FALLBACKS[3]!] = busy;
    mockFetch(routes);
    await expect(discoverFeeds(PAGE)).rejects.toMatchObject({ status: 429 });
  });

  it("reads a feed larger than the 2MB request default", async () => {
    const item = `<item><title>Post</title><link>https://blog.example/p</link><description>${"x".repeat(1000)}</description></item>`;
    const big = `<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title>${item.repeat(3000)}</channel></rss>`;
    const head = `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`;
    mockFetch({ [PAGE]: html(page(head)), "https://blog.example/feed.xml": reply.text(big) });
    await expect(discoverFeeds(PAGE)).resolves.toEqual([{ url: "https://blog.example/feed.xml" }]);
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
