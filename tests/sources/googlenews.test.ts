import { afterEach, describe, expect, it, vi } from "vitest";
import { type GoogleNewsFeed, SourcesSchema } from "../../src/config/schema.js";
import { fetchGoogleNewsItems, googleNewsName, googleNewsUrl } from "../../src/sources/googlenews.js";
import { fetchSource } from "../../src/sources/index.js";
import { mockFetch, reply } from "../helpers/mockFetch.js";

const feed: GoogleNewsFeed = { id: "pet-funeral", type: "googlenews", query: "ペット葬儀 グッズ", locale: "ja-JP" };
const defaults = { itemsPerFeed: 3, maxItemsPerFeed: 20, maxContentChars: 2000 };

const rss = (titles: string[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Google News</title>${titles
    .map(
      (t, i) => `<item><title>${t} - PR TIMES</title><link>https://news.google.com/rss/articles/a${i}</link>
      <guid isPermaLink="false">a${i}</guid><pubDate>Thu, ${29 - i} Oct 2026 02:00:00 GMT</pubDate>
      <description>${t}</description></item>`,
    )
    .join("")}</channel></rss>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

const query = (url: string) => new URL(url).searchParams;

describe("googleNewsUrl", () => {
  it("searches the last week of the locale's edition without since", () => {
    const params = query(googleNewsUrl(feed));
    expect(params.get("q")).toBe("ペット葬儀 グッズ when:7d");
    expect([params.get("hl"), params.get("gl"), params.get("ceid")]).toEqual(["ja", "JP", "JP:ja"]);
  });

  it("searches from since, on one site or on any of several", () => {
    const since = new Date("2026-10-22T06:17:00Z");
    expect(query(googleNewsUrl({ ...feed, sites: ["prtimes.jp"] }, since)).get("q")).toBe(
      "ペット葬儀 グッズ site:prtimes.jp after:2026-10-22",
    );
    expect(query(googleNewsUrl({ ...feed, sites: ["prtimes.jp", "news.jprpet.com"] })).get("q")).toBe(
      "ペット葬儀 グッズ (site:prtimes.jp OR site:news.jprpet.com) when:7d",
    );
  });
});

describe("fetchGoogleNewsItems", () => {
  it("takes the newest entries, named after the query when the feed has no name", async () => {
    const mock = mockFetch({ [googleNewsUrl(feed)]: reply.text(rss(["a", "b", "c", "d"])) });
    const items = await fetchGoogleNewsItems(feed, defaults);
    expect(mock.calls).toHaveLength(1);
    expect(items.map((i) => i.title)).toEqual(["a - PR TIMES", "b - PR TIMES", "c - PR TIMES"]);
    expect(items[0]).toMatchObject({ kind: "googlenews", sourceId: "pet-funeral", sourceName: "ペット葬儀 グッズ" });
    expect(googleNewsName({ ...feed, name: "Funeral goods" })).toBe("Funeral goods");
  });

  it("is what fetchSource runs for a googlenews feed, from since", async () => {
    const since = new Date("2026-10-22T00:00:00Z");
    mockFetch({ [googleNewsUrl(feed, since)]: reply.text(rss(["a"])) });
    expect(await fetchSource({ kind: "googlenews", feed }, { ...defaults, since })).toHaveLength(1);
  });
});

describe("googlenews in sources.yml", () => {
  it("defaults the locale and checks the sites and locale", () => {
    const parsed = SourcesSchema.parse({ version: 1, feeds: [{ id: "n", type: "googlenews", query: "x" }] });
    expect(parsed.feeds[0]).toEqual({ id: "n", type: "googlenews", query: "x", locale: "en-US" });
    const bad = SourcesSchema.safeParse({
      version: 1,
      feeds: [{ id: "n", type: "googlenews", query: "x", sites: ["https://prtimes.jp"], locale: "japanese" }],
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join("."))).toEqual(["feeds.0.sites.0", "feeds.0.locale"]);
  });
});
