import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGithubItems, feedUrl, isPrerelease, verifyRepo } from "../../src/sources/github.js";
import { FeedParseError } from "../../src/sources/rss.js";
import { HttpError } from "../../src/util/http.js";
import { mockFetch, reply, type Route } from "../helpers/mockFetch.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/feeds/${name}`, import.meta.url), "utf8");
}

const atom = (name: string) => reply.text(fixture(name), { headers: { "content-type": "application/atom+xml" } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("feedUrl", () => {
  it("points at the releases or tags Atom feed", () => {
    expect(feedUrl("vercel/next.js", "releases")).toBe("https://github.com/vercel/next.js/releases.atom");
    expect(feedUrl("vercel/next.js", "tags")).toBe("https://github.com/vercel/next.js/tags.atom");
  });
});

describe("isPrerelease", () => {
  it.each([
    ["v1.0.0-alpha", true],
    ["v1.0.0-beta.2", true],
    ["1.0.0-beta1", true],
    ["v2.0.0-rc.1", true],
    ["V1.0.0-RC1", true],
    ["v16.1.0-canary.3", true],
    ["v15.0.0-next.4", true],
    ["1.0.0-preview", true],
    ["v1.0.0-nightly.20261020", true],
    ["0.1.0-dev", true],
    ["v1.0.0", false],
    ["v16.1.0", false],
    ["eslint-config-next@14.0.0", false],
    ["v2.0.0-devtools", false],
    ["release-candidate", false],
    ["nightly", false],
  ])("%s → %s", (tag, expected) => {
    expect(isPrerelease(tag)).toBe(expected);
  });
});

describe("verifyRepo", () => {
  const repo = "acme/widget";
  const releases = feedUrl(repo, "releases");
  const tags = feedUrl(repo, "tags");

  it.each<[string, Record<string, Route>, Awaited<ReturnType<typeof verifyRepo>>]>([
    ["has releases", { [releases]: atom("github-releases.atom") }, { status: "found", feed: "releases" }],
    [
      "has only tags",
      { [releases]: atom("github-empty.atom"), [tags]: atom("github-tags.atom") },
      { status: "found", feed: "tags" },
    ],
    [
      "has neither",
      { [releases]: atom("github-empty.atom"), [tags]: atom("github-empty.atom") },
      { status: "empty" },
    ],
    ["does not exist", { [releases]: reply.status(404) }, { status: "not_found" }],
  ])("%s", async (_name, routes, expected) => {
    const fm = mockFetch(routes);
    expect(await verifyRepo(repo)).toEqual(expected);
    // Only an empty releases feed falls back to tags.
    expect(fm.callsTo(tags)).toHaveLength(tags in routes ? 1 : 0);
  });

  it("throws when the check itself fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockFetch({ [releases]: reply.status(500) });
    const result = verifyRepo(repo).catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ name: "HttpError", status: 500 });
  });

  it("throws on a response that is not a feed", async () => {
    mockFetch({ [releases]: reply.text(fixture("not-a-feed.html"), { headers: { "content-type": "text/html" } }) });
    await expect(verifyRepo(repo)).rejects.toBeInstanceOf(FeedParseError);
  });
});

describe("fetchGithubItems", () => {
  const defaults = { itemsPerFeed: 3, maxContentChars: 2000 };
  const next = {
    id: "nextjs",
    type: "github" as const,
    name: "Next.js releases",
    repo: "vercel/next.js",
    feed: "releases" as const,
    includePrereleases: false,
  };
  const widgetTags = { ...next, id: "widget", name: "Widget tags", repo: "acme/widget", feed: "tags" as const };

  it("drops prereleases by default", async () => {
    mockFetch({ [feedUrl(next.repo, "releases")]: atom("github-releases.atom") });
    const items = await fetchGithubItems(next, defaults);
    expect(items.map((i) => i.title)).toEqual(["v16.1.0"]);
    expect(items[0]).toMatchObject({
      sourceId: "nextjs",
      sourceName: "Next.js releases",
      kind: "github",
      url: "https://github.com/vercel/next.js/releases/tag/v16.1.0",
    });
  });

  it("keeps prereleases when asked", async () => {
    mockFetch({ [feedUrl(next.repo, "releases")]: atom("github-releases.atom") });
    const items = await fetchGithubItems({ ...next, includePrereleases: true }, defaults);
    expect(items.map((i) => i.title)).toEqual(["v16.1.0", "v16.1.0-canary.3"]);
  });

  it("reads the tags feed and filters before cutting to itemsPerFeed", async () => {
    const fm = mockFetch({ [feedUrl(widgetTags.repo, "tags")]: atom("github-tags.atom") });
    // The newest tag is a release candidate; the stable one must still make the cut.
    const items = await fetchGithubItems(widgetTags, { ...defaults, itemsPerFeed: 1 });
    expect(items.map((i) => i.title)).toEqual(["v1.9.0"]);
    expect(fm.calls.map((c) => c.url)).toEqual(["https://github.com/acme/widget/tags.atom"]);
  });

  it("judges by the tag, not the release name", async () => {
    const entry = (tag: string, title: string, updated: string) => `
      <entry>
        <id>tag:github.com,2008:Repository/1/${tag}</id>
        <updated>${updated}</updated>
        <link rel="alternate" type="text/html" href="https://github.com/vercel/next.js/releases/tag/${tag}"/>
        <title>${title}</title>
      </entry>`;
    const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>x</id><title>x</title>
      ${entry("v17.0.0-beta.1", "Next.js 17 Beta", "2026-10-25T00:00:00Z")}
      ${entry("v16.2.0", "Next.js 16.2", "2026-10-24T00:00:00Z")}</feed>`;
    mockFetch({ [feedUrl(next.repo, "releases")]: reply.text(feed) });
    const items = await fetchGithubItems(next, defaults);
    expect(items.map((i) => i.title)).toEqual(["Next.js 16.2"]);
  });

  it("passes HTTP errors through", async () => {
    mockFetch({ [feedUrl(next.repo, "releases")]: reply.status(404) });
    await expect(fetchGithubItems(next, defaults)).rejects.toBeInstanceOf(HttpError);
  });
});
