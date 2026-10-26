import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGithubItems, feedUrl, isPrerelease, verifyRepo } from "../../src/sources/github.js";
import { FeedParseError } from "../../src/sources/rss.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { HttpError } from "../../src/util/http.js";
import { mockFetch, reply, type Route } from "../helpers/mockFetch.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/feeds/${name}`, import.meta.url), "utf8");
}

const atom = (name: string) => reply.text(fixture(name), { headers: { "content-type": "application/atom+xml" } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetLog();
});

const api = (path: string) => `https://api.github.com/repos/${path}`;
const releasesApi = (repo: string) => api(`${repo}/releases?per_page=100`);

interface ReleaseFixture {
  tag: string;
  name?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  published?: string;
  body?: string;
}

function release(r: ReleaseFixture, repo = "vercel/next.js") {
  return {
    html_url: `https://github.com/${repo}/releases/tag/${r.tag}`,
    tag_name: r.tag,
    name: r.name === undefined ? r.tag : r.name,
    draft: r.draft ?? false,
    prerelease: r.prerelease ?? false,
    published_at: r.published ?? "2026-10-20T00:00:00Z",
    body_html: r.body ?? `<p>${r.tag}</p>`,
  };
}

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
    ["1.0.0a1", true],
    ["2.0.0rc1", true],
    ["3.1b2", true],
    ["2.0.0-M1", true],
    ["1.0-SNAPSHOT", true],
    ["v5.0.0-pre.1", true],
    ["v3.0.0-experimental", true],
    ["v1.2.0.beta1", true],
    ["next@15.0.0-canary.1", true],
    ["python3-dev@1.2.0", false],
    ["libfoo2-dev-v1.0.0", false],
    ["vue3-next@2.0.0", false],
    ["v1.0.0-1", false],
  ])("%s → %s", (tag, expected) => {
    expect(isPrerelease(tag)).toBe(expected);
  });
});

describe("verifyRepo", () => {
  const repo = "acme/widget";
  const tags = feedUrl(repo, "tags");
  const repoInfo = reply.json({ full_name: repo });
  const latest = (tag: string, at: string, r = repo) =>
    expect.objectContaining({ title: tag, url: `https://github.com/${r}/releases/tag/${tag}`, publishedAt: at, content: "" });

  it.each<[string, Record<string, Route>, Awaited<ReturnType<typeof verifyRepo>>]>([
    [
      "has releases",
      {
        [api(repo)]: repoInfo,
        [releasesApi(repo)]: reply.json([
          release({ tag: "v1.1.0-rc.1", prerelease: true, published: "2026-10-22T00:00:00Z" }, repo),
          release({ tag: "v1.0.0" }, repo),
        ]),
      },
      // The newest stable release, as a run without includePrereleases shows it.
      { status: "found", feed: "releases", latest: latest("v1.0.0", "2026-10-20T00:00:00.000Z") },
    ],
    [
      "has only prereleases",
      {
        [api(repo)]: repoInfo,
        [releasesApi(repo)]: reply.json([release({ tag: "v1.0.0-beta.2", prerelease: true }, repo)]),
      },
      {
        status: "found",
        feed: "releases",
        onlyPrereleases: true,
        latest: latest("v1.0.0-beta.2", "2026-10-20T00:00:00.000Z"),
      },
    ],
    [
      "has only drafts and tags",
      {
        [api(repo)]: repoInfo,
        [releasesApi(repo)]: reply.json([release({ tag: "v1.0.0", draft: true }, repo)]),
        [tags]: atom("github-tags.atom"),
      },
      { status: "found", feed: "tags", latest: latest("v1.9.0", "2026-10-20T12:00:00.000Z") },
    ],
    [
      "has only prerelease tags",
      {
        [api(repo)]: repoInfo,
        [releasesApi(repo)]: reply.json([]),
        [tags]: atom("github-tags-prerelease.atom"),
      },
      {
        status: "found",
        feed: "tags",
        onlyPrereleases: true,
        latest: latest("v2.0.0-rc.1", "2026-10-24T12:00:00.000Z"),
      },
    ],
    [
      "has neither",
      { [api(repo)]: repoInfo, [releasesApi(repo)]: reply.json([]), [tags]: atom("github-empty.atom") },
      { status: "empty" },
    ],
    ["does not exist", { [api(repo)]: reply.status(404) }, { status: "not_found" }],
    [
      "disappears before the tags check",
      { [api(repo)]: repoInfo, [releasesApi(repo)]: reply.json([]), [tags]: reply.status(404) },
      { status: "not_found" },
    ],
  ])("%s", async (_name, routes, expected) => {
    const fm = mockFetch(routes);
    expect(await verifyRepo(repo)).toEqual(expected);
    // Only a repository without releases falls back to tags.
    expect(fm.callsTo(tags)).toHaveLength(tags in routes ? 1 : 0);
  });

  it("reports the new name of a moved repository and checks it there", async () => {
    const moved = "neworg/widget";
    const fm = mockFetch({
      [api(repo)]: reply.redirect("https://api.github.com/repositories/42", JSON.stringify({ full_name: moved })),
      [releasesApi(moved)]: reply.json([release({ tag: "v1.0.0" }, moved)]),
    });
    expect(await verifyRepo(repo)).toEqual({
      status: "found",
      feed: "releases",
      movedTo: moved,
      latest: latest("v1.0.0", "2026-10-20T00:00:00.000Z", moved),
    });
    expect(fm.calls.map((c) => c.url)).toEqual([api(repo), releasesApi(moved)]);
  });

  it("does not count a change of case as a move", async () => {
    mockFetch({
      [api("Acme/Widget")]: repoInfo,
      [releasesApi(repo)]: reply.json([release({ tag: "v1.0.0" }, repo)]),
    });
    expect(await verifyRepo("Acme/Widget")).toMatchObject({ status: "found", feed: "releases" });
    expect(await verifyRepo("Acme/Widget")).not.toHaveProperty("movedTo");
  });

  it("throws when the check itself fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockFetch({ [api(repo)]: reply.status(500) });
    const result = verifyRepo(repo).catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ name: "HttpError", status: 500 });
  });

  it("throws on a response it does not understand", async () => {
    mockFetch({ [api(repo)]: repoInfo, [releasesApi(repo)]: reply.json({ message: "nope" }) });
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

  // The newest 15 are canaries, more than the Atom feed's 10-entry window.
  const canaries = Array.from({ length: 15 }, (_, i) =>
    release({
      tag: `v16.2.0-canary.${15 - i}`,
      prerelease: true,
      published: `2026-10-${String(25 - i).padStart(2, "0")}T00:00:00Z`,
    }),
  );
  const releases = [
    release({ tag: "v17.0.0", name: "Next.js 17", draft: true, published: "2026-10-26T00:00:00Z" }),
    ...canaries,
    release({ tag: "v16.1.0", name: "Next.js 16.1", published: "2026-10-01T00:00:00Z", body: "<h2>Fixes</h2>" }),
    release({ tag: "v16.0.0", name: null, published: "2026-09-01T00:00:00Z" }),
  ];

  it("finds stable releases behind a long run of canaries, skipping drafts", async () => {
    mockFetch({ [releasesApi(next.repo)]: reply.json(releases) });
    const items = await fetchGithubItems(next, defaults);
    expect(items.map((i) => i.title)).toEqual(["Next.js 16.1", "v16.0.0"]);
    expect(items[0]).toMatchObject({
      sourceId: "nextjs",
      sourceName: "Next.js releases",
      kind: "github",
      url: "https://github.com/vercel/next.js/releases/tag/v16.1.0",
      publishedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(items[0]?.content).toContain("Fixes");
  });

  it("keeps prereleases when asked", async () => {
    mockFetch({ [releasesApi(next.repo)]: reply.json(releases) });
    const items = await fetchGithubItems({ ...next, includePrereleases: true }, defaults);
    expect(items.map((i) => i.title)).toEqual(["v16.2.0-canary.15", "v16.2.0-canary.14", "v16.2.0-canary.13"]);
  });

  it("asks for rendered HTML and sends GITHUB_TOKEN when set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_example");
    const fm = mockFetch({ [releasesApi(next.repo)]: reply.json([]) });
    await fetchGithubItems(next, defaults);
    const [call] = fm.calls;
    expect(call?.headers.get("accept")).toBe("application/vnd.github.html+json");
    expect(call?.headers.get("authorization")).toBe("Bearer ghp_example");
  });

  it("works without a token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const fm = mockFetch({ [releasesApi(next.repo)]: reply.json([]) });
    await fetchGithubItems(next, defaults);
    expect(fm.calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("warns when every recent release is a prerelease", async () => {
    const lines: string[] = [];
    configureLog({ write: (s) => lines.push(s) });
    mockFetch({ [releasesApi(next.repo)]: reply.json(canaries) });
    expect(await fetchGithubItems(next, defaults)).toEqual([]);
    expect(lines).toEqual([
      "pochi: warn: nextjs: all 15 recent releases of vercel/next.js are prereleases; " +
        "set includePrereleases: true to follow them\n",
    ]);
  });

  it("reads the tags feed and filters before cutting to itemsPerFeed", async () => {
    const fm = mockFetch({ [feedUrl(widgetTags.repo, "tags")]: atom("github-tags.atom") });
    // The newest tag is a release candidate; the stable one must still make the cut.
    const items = await fetchGithubItems(widgetTags, { ...defaults, itemsPerFeed: 1 });
    expect(items.map((i) => i.title)).toEqual(["v1.9.0"]);
    expect(fm.calls.map((c) => c.url)).toEqual(["https://github.com/acme/widget/tags.atom"]);
  });

  it("judges a tag by its guid before its link or title", async () => {
    const entry = (guidTag: string, linkTag: string, title: string, updated: string) => `
      <entry>
        <id>tag:github.com,2008:Repository/1/${guidTag}</id>
        <updated>${updated}</updated>
        <link rel="alternate" type="text/html" href="https://github.com/other/repo/releases/tag/${linkTag}"/>
        <title>${title}</title>
      </entry>`;
    const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>x</id><title>x</title>
      ${entry("v2.0.0-beta.1", "v2.0.0", "Widget 2", "2026-10-25T00:00:00Z")}
      ${entry("v1.9.1", "v1.9.1-rc.1", "Widget 1.9.1 Beta?", "2026-10-24T00:00:00Z")}</feed>`;
    mockFetch({ [feedUrl(widgetTags.repo, "tags")]: reply.text(feed) });
    const items = await fetchGithubItems(widgetTags, defaults);
    expect(items.map((i) => i.title)).toEqual(["Widget 1.9.1 Beta?"]);
  });

  it("passes HTTP errors through", async () => {
    mockFetch({ [releasesApi(next.repo)]: reply.status(404) });
    await expect(fetchGithubItems(next, defaults)).rejects.toBeInstanceOf(HttpError);
  });

  it("rejects a response that is not a list of releases", async () => {
    mockFetch({ [releasesApi(next.repo)]: reply.text("<html>") });
    await expect(fetchGithubItems(next, defaults)).rejects.toBeInstanceOf(FeedParseError);
  });
});
