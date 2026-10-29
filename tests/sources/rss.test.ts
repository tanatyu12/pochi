import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEED_MAX_BYTES, FeedParseError, fetchRssItems, parseFeedText, toItems, type RawEntry } from "../../src/sources/rss.js";
import { itemId, urlKey } from "../../src/util/hash.js";
import { HttpError } from "../../src/util/http.js";
import { mockFetch, reply } from "../helpers/mockFetch.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/feeds/${name}`, import.meta.url), "utf8");
}

const source = { id: "blog", name: "Example Blog" };
const opts = { baseUrl: "https://blog.example.com/feed.xml", itemsPerFeed: 10, maxItemsPerFeed: 20, maxContentChars: 2000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

// Pins what feedsmith hands us, so an upgrade that changes its output shape fails here.
describe("parseFeedText", () => {
  it("reads RSS 2.0", () => {
    const entries = parseFeedText(fixture("rss2.xml"));
    expect(entries).toHaveLength(6);
    expect(entries[0]).toEqual({
      guid: "https://blog.example.com/?p=1",
      link: "https://blog.example.com/older",
      title: { value: "Older post", format: "inline" },
      published: "Mon, 19 Oct 2026 09:00:00 +0000",
      html: "<p>Older &amp; wiser</p>",
    });
    // content:encoded wins over description; CDATA arrives as is.
    expect(entries[1]).toMatchObject({
      guid: "post-3",
      link: "/posts/newest?utm_source=rss",
      title: { value: "Newest <em>post</em> &amp; more", format: "inline" },
      html: "<h2>Intro</h2><p>Full <b>body</b> text.</p>",
    });
    expect(entries[3]?.published).toBe("2026-10-22T08:00:00Z");
    expect(entries[4]?.link).toBe("https://blog.example.com/permalink-only");
    expect(entries[5]?.link).toBeUndefined();
  });

  it("reads Atom, preferring the HTML alternate link", () => {
    const [one, two] = parseFeedText(fixture("atom.xml"));
    expect(one).toEqual({
      guid: "tag:example.com,2026:1",
      link: "/entries/1",
      title: { value: "Entry &lt;one&gt;", format: "html" },
      published: "2026-10-23T10:00:00Z",
      html: "<p>Content <b>one</b></p>",
      text: undefined,
    });
    expect(two).toEqual({
      guid: "tag:example.com,2026:2",
      link: "https://example.com/entries/2",
      title: { value: "Entry two", format: "text" },
      published: "2026-10-25T08:00:00+09:00",
      html: undefined,
      text: "Plain &lt;summary&gt; only",
    });
  });

  it("reads RDF with dc:date and rdf:about as the guid", () => {
    expect(parseFeedText(fixture("rdf.xml"))).toEqual([
      {
        guid: "https://rdf.example.jp/entry/1",
        link: "https://rdf.example.jp/entry/1",
        title: { value: "日本語の記事", format: "inline" },
        published: "2026-10-21T09:00:00+09:00",
        html: "本文です。",
      },
    ]);
  });

  it("reads JSON Feed, keeping content_text as text", () => {
    const [html, text] = parseFeedText(fixture("feed.json"));
    expect(html).toMatchObject({ guid: "j1", link: "https://json.example.com/1", html: "<p>Hello <em>JSON</em></p>" });
    expect(html?.text).toBeUndefined();
    expect(text).toMatchObject({
      guid: "j2",
      link: "https://elsewhere.example.com/2",
      published: "2026-10-22T00:00:00Z",
      text: "Use &amp; literally, and a < b",
    });
    expect(text?.html).toBeUndefined();
  });

  it("decodes GitHub's escaped release notes to real HTML", () => {
    const [release] = parseFeedText(fixture("github-releases.atom"));
    expect(release?.html).toContain("<h3>Core Changes</h3>");
    expect(release?.html).toContain("Fix &lt;Link&gt; prefetch");
  });

  const atom = (entry: string) =>
    `<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title><id>x</id><updated>2026-10-01T00:00:00Z</updated>` +
    `<entry><id>e</id><title>t</title><updated>2026-10-01T00:00:00Z</updated>${entry}</entry></feed>`;

  it("reads Atom content with a text/* MIME type as literal text", () => {
    const [entry] = parseFeedText(atom(`<content type="text/plain">hello &lt;b&gt;</content>`));
    expect(entry).toMatchObject({ text: "hello <b>", html: undefined });
  });

  it.each([
    ["an unusable MIME type", `<content type="application/octet-stream">aGVsbG8=</content>`],
    ["only whitespace", `<content type="html">   </content>`],
  ])("falls back to the summary when the content has %s", (_, content) => {
    const [entry] = parseFeedText(atom(`${content}<summary>sum</summary>`));
    expect(entry).toMatchObject({ text: "sum", html: undefined });
  });

  it.each([
    ["self", `<link rel="self" href="https://x.example/api/1"/>`],
    ["enclosure", `<link rel="enclosure" type="audio/mpeg" href="https://x.example/1.mp3"/>`],
  ])("takes no link from a lone rel=%s", (_, link) => {
    expect(parseFeedText(atom(link))[0]?.link).toBeUndefined();
  });

  it("matches the HTML alternate by media type, ignoring parameters", () => {
    const links =
      `<link rel="alternate" type="application/xhtml+xml" href="https://x.example/1"/>` +
      `<link rel="alternate" type="Text/HTML; charset=utf-8" href="https://x.example/2"/>`;
    expect(parseFeedText(atom(links))[0]?.link).toBe("https://x.example/2");
  });

  it.each([
    ["a BOM", fixture("bom.xml")],
    ["leading whitespace", `\n  ${fixture("bom.xml").replace(/^﻿/, "")}`],
  ])("accepts %s", (_, text) => {
    expect(parseFeedText(text).map((e) => e.title?.value)).toEqual(["After BOM"]);
  });

  it("returns no entries for an empty feed", () => {
    const rss = `<rss version="2.0"><channel><title>x</title><link>https://x.example/</link><description>d</description></channel></rss>`;
    expect(parseFeedText(rss)).toEqual([]);
  });

  it.each([
    ["broken XML", fixture("broken.xml"), "malformed feed"],
    ["an HTML page", fixture("not-a-feed.html"), "not a feed"],
    ["an empty body", "", "not a feed"],
    ["JSON that is not a feed", "{}", "not a feed"],
  ])("rejects %s without quoting it", (_, text, message) => {
    let caught: unknown;
    try {
      parseFeedText(text);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FeedParseError);
    expect((caught as Error).message).toBe(message);
  });
});

describe("toItems", () => {
  const entry = (over: Partial<RawEntry>): RawEntry => ({ link: "https://blog.example.com/x", ...over });

  it("sorts newest first, puts undated entries last and keeps itemsPerFeed", () => {
    const items = toItems(parseFeedText(fixture("rss2.xml")), source, opts);
    expect(items.map((i) => i.url)).toEqual([
      "https://blog.example.com/posts/newest?utm_source=rss",
      "https://blog.example.com/dc",
      "https://blog.example.com/permalink-only",
      "https://blog.example.com/older",
      "https://blog.example.com/undated",
    ]);
    expect(items[0]?.publishedAt).toBe("2026-10-24T03:30:00.000Z");
    expect(items.at(-1)?.publishedAt).toBeUndefined();
    expect(toItems(parseFeedText(fixture("rss2.xml")), source, { ...opts, itemsPerFeed: 2 })).toHaveLength(2);
  });

  it("keeps document order for ties and undated entries", () => {
    const entries = [
      entry({ link: "/a" }),
      entry({ link: "/b", published: "2026-10-01T00:00:00Z" }),
      entry({ link: "/c" }),
      entry({ link: "/d", published: "2026-10-01T00:00:00Z" }),
    ];
    expect(toItems(entries, source, opts).map((i) => new URL(i.url).pathname)).toEqual(["/b", "/d", "/a", "/c"]);
  });

  it("resolves relative links against the base URL and drops entries without a usable link", () => {
    const items = toItems(
      [entry({ link: "../up" }), entry({ link: undefined }), entry({ link: "javascript:alert(1)" }), entry({ link: "mailto:a@b.c" })],
      source,
      { ...opts, baseUrl: "https://blog.example.com/feeds/main.xml" },
    );
    expect(items.map((i) => i.url)).toEqual(["https://blog.example.com/up"]);
  });

  describe("since", () => {
    const dated = (n: number, day: number) => entry({ link: `/p${n}`, published: `2026-10-${day}T00:00:00Z` });
    // Newest first: 25, 24, 23, 22, 20, then one undated.
    const entries = [dated(1, 25), dated(2, 24), dated(3, 23), dated(4, 22), dated(5, 20), entry({ link: "/undated" })];
    const paths = (items: { url: string }[]) => items.map((i) => new URL(i.url).pathname);

    it("keeps every entry published since then beyond itemsPerFeed", () => {
      const items = toItems(entries, source, { ...opts, itemsPerFeed: 2, since: new Date("2026-10-22T00:00:00Z") });
      expect(paths(items)).toEqual(["/p1", "/p2", "/p3", "/p4"]);
    });

    it("stops at maxItemsPerFeed", () => {
      const since = new Date("2026-10-01T00:00:00Z");
      expect(toItems(entries, source, { ...opts, itemsPerFeed: 1, maxItemsPerFeed: 3, since })).toHaveLength(3);
    });

    it("never takes fewer than itemsPerFeed, and adds no undated entries", () => {
      const since = new Date("2026-10-30T00:00:00Z");
      expect(paths(toItems(entries, source, { ...opts, itemsPerFeed: 2, since }))).toEqual(["/p1", "/p2"]);
      const all = toItems(entries, source, { ...opts, itemsPerFeed: 1, since: new Date("2026-10-01T00:00:00Z") });
      expect(paths(all)).not.toContain("/undated");
    });
  });

  it("does not count dropped entries against itemsPerFeed", () => {
    const items = toItems([entry({ link: undefined }), entry({ link: "/a" })], source, { ...opts, itemsPerFeed: 1 });
    expect(items).toHaveLength(1);
  });

  it("derives the id from the guid, else the normalized URL", () => {
    const [byGuid] = toItems([entry({ guid: "post-3" })], source, opts);
    expect(byGuid?.id).toBe(itemId("blog", "post-3"));
    const [byUrl] = toItems([entry({ link: "https://Blog.example.com/x/?utm_source=rss#top" })], source, opts);
    expect(byUrl?.id).toBe(itemId("blog", "https://blog.example.com/x"));
    const [otherSource] = toItems([entry({ guid: "post-3" })], { ...source, id: "other" }, opts);
    expect(otherSource?.id).not.toBe(byGuid?.id);
  });

  it("keeps one item per guid or URL, the newest, before counting itemsPerFeed", () => {
    const entries = [
      entry({ guid: "a", link: "/a", published: "2026-10-01T00:00:00Z" }),
      entry({ guid: "a", link: "/a", published: "2026-10-03T00:00:00Z" }),
      entry({ guid: "a2", link: "/a?utm_source=rss", published: "2026-10-02T00:00:00Z" }),
      entry({ guid: "b", link: "/b", published: "2026-09-01T00:00:00Z" }),
    ];
    const items = toItems(entries, source, { ...opts, itemsPerFeed: 2 });
    expect(items.map((i) => [i.id, i.publishedAt])).toEqual([
      [itemId("blog", "a"), "2026-10-03T00:00:00.000Z"],
      [itemId("blog", "b"), "2026-09-01T00:00:00.000Z"],
    ]);
  });

  it("keys the item by its normalized URL as well", () => {
    const [item] = toItems([entry({ guid: "g", link: "/post/?utm_source=rss#top" })], source, opts);
    expect(item?.url).toBe("https://blog.example.com/post/?utm_source=rss#top");
    expect(item?.urlKey).toBe(urlKey("https://blog.example.com/post"));
  });

  it("fills source fields and defaults kind to rss", () => {
    const [item] = toItems([entry({})], source, opts);
    expect(item).toMatchObject({ sourceId: "blog", sourceName: "Example Blog", kind: "rss" });
    const [github] = toItems([entry({})], { ...source, kind: "github" }, opts);
    expect(github?.kind).toBe("github");
  });

  it("turns titles into one line of plain text", () => {
    const items = toItems(parseFeedText(fixture("rss2.xml")), source, opts);
    expect(items[0]?.title).toBe("Newest post & more");
    const [atom] = toItems(parseFeedText(fixture("atom.xml")), source, opts);
    expect(atom?.title).toBe("Entry two");
    const [html] = toItems([entry({ title: { value: "<p>Line\none</p><p>two</p>", format: "html" } })], source, opts);
    expect(html?.title).toBe("Line one two");
    const [literal] = toItems([entry({ title: { value: "a &amp; <b>", format: "text" } })], source, opts);
    expect(literal?.title).toBe("a &amp; <b>");
  });

  it("keeps escaped tag names in titles", () => {
    const rss = (title: string) =>
      `<rss version="2.0"><channel><title>x</title><link>https://x.example/</link><description>d</description>` +
      `<item><title>${title}</title><link>https://x.example/1</link></item></channel></rss>`;
    const title = (text: string) => toItems(parseFeedText(text), source, opts)[0]?.title;
    expect(title(rss("Why &lt;canvas&gt; matters"))).toBe("Why <canvas> matters");
    expect(title(rss("&amp;lt;Suspense&amp;gt; and &lt;b&gt;bold&lt;/b&gt;"))).toBe("<Suspense> and bold");
    const atomHtml = toItems([entry({ title: { value: "&lt;Link&gt; prefetch", format: "html" } })], source, opts);
    expect(atomHtml[0]?.title).toBe("<Link> prefetch");
    const inline = toItems([entry({ title: { value: "a<br>b <code>c</code> d<b>e</b>", format: "inline" } })], source, opts);
    expect(inline[0]?.title).toBe("a b <code>c</code> de");
  });

  it("falls back to the URL for untitled entries", () => {
    const [item] = toItems([entry({ link: "https://blog.example.com/untitled" })], source, opts);
    expect(item?.title).toBe("https://blog.example.com/untitled");
  });

  it("cuts titles at 300 code points without splitting emoji", () => {
    const [item] = toItems([entry({ title: { value: "🎉".repeat(400), format: "inline" } })], source, opts);
    const chars = Array.from(item?.title ?? "");
    expect(chars).toHaveLength(300);
    expect(chars.at(-1)).toBe("…");
    expect(chars.slice(0, -1).every((c) => c === "🎉")).toBe(true);
  });

  it("converts HTML bodies to text within maxContentChars", () => {
    const [item] = toItems(parseFeedText(fixture("github-releases.atom")), source, opts);
    expect(item?.content).toBe("Core Changes\nFix <Link> prefetch: #1");
    const [short] = toItems([entry({ html: `<p>${"あ".repeat(50)}</p>` })], source, { ...opts, maxContentChars: 10 });
    expect(Array.from(short?.content ?? "")).toHaveLength(10);
  });

  it("keeps plain text bodies literal", () => {
    const items = toItems(parseFeedText(fixture("feed.json")), source, opts);
    expect(items.find((i) => i.url.includes("elsewhere"))?.content).toBe("Use &amp; literally, and a < b");
    const [lines] = toItems([entry({ text: " a   b \n\n\n c " })], source, opts);
    expect(lines?.content).toBe("a b\nc");
    const text = ["Intro", "x".repeat(100), "# Breaking Changes", "y".repeat(100)].join("\n");
    const [cut] = toItems([entry({ text })], source, { ...opts, maxContentChars: 120 });
    // The preamble gives way to the heading and its section, as in htmlToText.
    expect(cut?.content).toMatch(/^Intro\n# Breaking Changes\ny+…$/);
  });

  it("leaves content empty when the entry has no body", () => {
    expect(toItems([entry({})], source, opts)[0]?.content).toBe("");
  });

  it("ignores dates it cannot parse", () => {
    expect(toItems([entry({ published: "yesterday" })], source, opts)[0]?.publishedAt).toBeUndefined();
  });
});

describe("fetchRssItems", () => {
  const feed = { id: "blog", type: "rss" as const, name: "Example Blog", url: "https://blog.example.com/feed" };
  const defaults = { itemsPerFeed: 3, maxItemsPerFeed: 20, maxContentChars: 2000 };

  it("fetches, parses and resolves links against the final URL", async () => {
    mockFetch({ [feed.url]: reply.redirect("https://cdn.example.net/blog/feed.xml", fixture("rss2.xml")) });
    const items = await fetchRssItems(feed, defaults);
    expect(items).toHaveLength(3);
    expect(items[0]?.url).toBe("https://cdn.example.net/posts/newest?utm_source=rss");
    expect(items[0]?.sourceName).toBe("Example Blog");
  });

  it("reads a full-content feed larger than the 2MB request default, up to FEED_MAX_BYTES", async () => {
    const item = `<item><title>Post</title><link>https://blog.example.com/p</link><description>${"x".repeat(1000)}</description></item>`;
    const big = `<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title>${item.repeat(3000)}</channel></rss>`;
    mockFetch({ [feed.url]: reply.text(big) });
    // Every entry shares one link, so they collapse to one item.
    expect(await fetchRssItems(feed, defaults)).toHaveLength(1);

    mockFetch({ [feed.url]: reply.text(" ".repeat(FEED_MAX_BYTES + 1)) });
    await expect(fetchRssItems(feed, defaults)).rejects.toMatchObject({ name: "HttpError", kind: "too_large" });
  });

  it("passes HTTP errors through", async () => {
    mockFetch({ [feed.url]: reply.status(404) });
    await expect(fetchRssItems(feed, defaults)).rejects.toBeInstanceOf(HttpError);
  });

  it("reports a page that is not a feed", async () => {
    mockFetch({ [feed.url]: reply.text(fixture("not-a-feed.html"), { headers: { "content-type": "text/html" } }) });
    await expect(fetchRssItems(feed, defaults)).rejects.toBeInstanceOf(FeedParseError);
  });
});
