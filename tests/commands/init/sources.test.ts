import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { queryIdFrom } from "../../../src/commands/init/ids.js";
import { newSession } from "../../../src/commands/init/session.js";
import { askSources } from "../../../src/commands/init/sources.js";
import type { GoogleNewsFeed } from "../../../src/config/schema.js";
import { LlmError } from "../../../src/llm/schema.js";
import { googleNewsUrl } from "../../../src/sources/googlenews.js";
import { mockFetch, reply } from "../../helpers/mockFetch.js";
import { type ScriptedPrompter, scriptedPrompter } from "../../helpers/scriptedPrompter.js";
import {
  API,
  BASE_ROUTES,
  CONTEXT,
  FIXTURES,
  NEWS,
  QUIET,
  SIMON,
  TAVILY,
  TAVILY_FIXTURE,
  WEB,
  atom,
  fakeLlm,
  rejection,
  release,
  repoRoutes,
  sources,
  useInitSandbox,
} from "./fixtures.js";

useInitSandbox();

describe("askSources: repositories", () => {
  it("does not offer Done until a source is added", async () => {
    const { result } = sources(["done"]);
    expect(await rejection(result)).toMatchObject({ message: expect.stringMatching(/not an option/) });
  });

  it("checks a typed owner/repo on GitHub without asking the model", async () => {
    const llm = fakeLlm();
    const { result } = sources(["repo", "vercel/next.js", "done"], llm.client);
    expect((await result).feeds).toEqual([{ id: "next-js", type: "github", name: "vercel/next.js", repo: "vercel/next.js" }]);
    expect(llm.calls).toEqual(["queries"]);
  });

  it("rejects names that are not owner/repo without an LLM, and malformed repos with one", async () => {
    for (const repo of ["next.js", "vercel/next.js/x", "a/..", "own.er/repo"]) {
      expect(await rejection(sources(["repo", repo]).result)).toMatchObject({ message: expect.stringMatching(/owner\/repo/) });
    }
    for (const repo of ["vercel/next.js/x", "a/.."]) {
      expect(await rejection(sources(["repo", repo], fakeLlm().client).result)).toMatchObject({
        message: expect.stringMatching(/owner\/repo/),
      });
    }
  });

  it("goes back to the menu when an answer replayed without validation is not usable", async () => {
    // Going back replays answers without validating them again.
    const scripted = scriptedPrompter(["repo", "next.js", "site", "not a url", "repo", "vercel/next.js", "done"]);
    const prompter: ScriptedPrompter = { ...scripted, text: (opts) => scripted.text({ ...opts, validate: undefined }) };
    const result = await askSources(newSession(prompter, CONTEXT));
    expect(scripted.remaining).toEqual([]);
    expect(scripted.shown).toContain("warn: Without Claude, enter the repository as owner/repo.");
    expect(scripted.shown).toContain("warn: Enter an absolute http(s) URL.");
    expect(result.feeds).toEqual([{ id: "next-js", type: "github", name: "vercel/next.js", repo: "vercel/next.js" }]);
  });

  it("goes back to the choice of source when a repository is missing or has nothing to watch", async () => {
    mockFetch({
      ...BASE_ROUTES,
      [`${API}/ghost/missing`]: reply.status(404),
      ...repoRoutes("acme/empty", { releases: [] }),
      "https://github.com/acme/empty/tags.atom": reply.text(await readFile(join(FIXTURES, "github-empty.atom"), "utf8")),
    });
    const { prompter, result } = sources(["repo", "ghost/missing", "repo", "acme/empty", "repo", "  ", "repo", "vercel/next.js", "done"]);
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js"]);
    expect(prompter.shown).toContain("warn: ghost/missing was not found on GitHub.");
    expect(prompter.shown).toContain("warn: acme/empty has no releases or tags to watch.");
  });

  it("follows a moved repository and watches tags when it has no releases", async () => {
    const tags = await readFile(join(FIXTURES, "github-tags.atom"), "utf8");
    mockFetch({
      ...repoRoutes("old/widget", { fullName: "acme/widget", releases: [] }),
      "https://github.com/acme/widget/tags.atom": reply.text(tags),
    });
    const { prompter, result } = sources(["repo", "old/widget", "done"]);
    expect((await result).feeds).toEqual([
      { id: "widget", type: "github", name: "acme/widget", repo: "acme/widget", feed: "tags" },
    ]);
    expect(prompter.shown).toContain("note: old/widget moved to acme/widget; watching that instead.");
    expect(prompter.shown).toContain("note: acme/widget (github): v1.9.0\n2026-10-20\nhttps://github.com/acme/widget/releases/tag/v1.9.0");
  });

  it("follows prereleases when a repository has nothing else", async () => {
    mockFetch(repoRoutes("acme/canary", { releases: [release("v1.0.0-canary.1", true)] }));
    const { prompter, result } = sources(["repo", "acme/canary", "done"]);
    expect((await result).feeds![0]).toMatchObject({ repo: "acme/canary", includePrereleases: true });
    expect(prompter.shown).toContain("note: acme/canary has only prereleases so far; following them.");
  });

  it("lets the user add a typed repository GitHub could not check", async () => {
    mockFetch({ [`${API}/acme/private`]: reply.status(403) });
    const { prompter, result } = sources(["repo", "acme/private", true, "done", true]);
    expect((await result).feeds).toEqual([{ id: "private", type: "github", name: "acme/private", repo: "acme/private" }]);
    expect(prompter.asked).toContain("Add acme/private anyway?");
    expect(prompter.shown.some((s) => s.startsWith("warn: acme/private (github) failed: "))).toBe(true);
  });

  it("offers only the candidates GitHub confirms, at most three", async () => {
    const fetch = mockFetch({
      ...BASE_ROUTES,
      [`${API}/ghost/missing`]: reply.status(404),
      [`${API}/acme/forbidden`]: reply.status(403),
    });
    const llm = fakeLlm({
      repos: () => [
        { repo: "not a repo", note: "" },
        { repo: " vercel/next.js ", note: "The framework\n\u001b[31mred\u001b[0m" },
        { repo: "Vercel/Next.js", note: "dup" },
        { repo: "ghost/missing", note: "" },
        { repo: "acme/forbidden", note: "" },
        { repo: "acme/fourth", note: "" },
      ],
    });
    const { prompter, result } = sources(["repo", "Next.js", "vercel/next.js", "done"], llm.client);
    expect((await result).feeds!.map((f) => (f.type === "github" ? f.repo : "url" in f ? f.url : f.query))).toEqual(["vercel/next.js"]);
    expect(llm.calls).toEqual(["repo:Next.js", "queries"]);
    expect(prompter.options["Which repository is Next.js?"]).toEqual(["vercel/next.js", "none"]);
    expect(prompter.shown).toContain("warn: Could not check 1 candidate on GitHub; left out.");
    expect(fetch.calls.map((c) => c.url)).not.toContain(`${API}/acme/fourth`);
  });

  it("goes back when no candidate exists or none is chosen", async () => {
    mockFetch({ ...BASE_ROUTES, [`${API}/ghost/missing`]: reply.status(404) });
    const llm = fakeLlm({ repos: (name) => (name === "Ghost" ? [{ repo: "ghost/missing", note: "" }] : [{ repo: "vercel/next.js", note: "" }]) });
    const { prompter, result } = sources(
      ["repo", "Ghost", "repo", "Next.js", "none", "repo", "vercel/next.js", "done"],
      llm.client,
    );
    expect((await result).feeds!.map((f) => (f.type === "github" ? f.repo : "url" in f ? f.url : f.query))).toEqual(["vercel/next.js"]);
    expect(prompter.shown).toContain("warn: No GitHub repository found for Ghost; enter it as owner/repo.");
  });

  it("stops asking the model after an auth error, but keeps it after a transient one", async () => {
    const kinds = ["transport", "auth"] as const;
    const llm = fakeLlm({
      repos: () => {
        throw new LlmError(kinds[llm.calls.length - 1]!, "failed");
      },
    });
    const first = sources(["repo", "Next.js", "repo", "Next.js", "repo", "vercel/next.js", "done"], llm.client);
    await first.result;
    expect(llm.calls).toEqual(["repo:Next.js", "repo:Next.js"]);
    expect(first.prompter.shown).toContain("warn: Claude could not answer (transport).");
    expect(first.prompter.shown).toContain("warn: Claude is not usable (auth); continuing without it.");
    expect(first.prompter.asked.at(-2)).toBe("GitHub repository (empty to go back)");
  });

  it("gives clashing names distinct ids and skips sources already added", async () => {
    mockFetch({
      ...repoRoutes("vercel/next.js"),
      [`${API}/Vercel/Next.js`]: reply.json({ full_name: "vercel/next.js" }),
      ...repoRoutes("someone/next.js"),
    });
    const { prompter, result } = sources([
      "repo",
      " vercel/next.js ",
      "repo",
      "Vercel/Next.js",
      "repo",
      "someone/next.js",
      "done",
    ]);
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js", "next-js-2"]);
    expect(prompter.shown).toContain("warn: Already added; skipped.");
  });

  it("skips a repository already added before asking GitHub or checking candidates", async () => {
    const fetch = mockFetch(BASE_ROUTES);
    const llm = fakeLlm({ repos: () => [{ repo: "vercel/next.js", note: "" }] });
    const { prompter, result } = sources(
      ["repo", "vercel/next.js", "repo", "Vercel/Next.js", "repo", "Next.js", "done"],
      llm.client,
    );
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js"]);
    expect(prompter.shown.filter((s) => s === "warn: Already added; skipped.")).toHaveLength(2);
    expect(fetch.calls.filter((c) => c.url.toLowerCase() === `${API}/vercel/next.js`)).toHaveLength(1);
  });

  it("does not claim a repository is missing when GitHub could not be asked", async () => {
    mockFetch({ ...BASE_ROUTES, [`${API}/acme/limited`]: reply.status(403) });
    const llm = fakeLlm({ repos: (name) => (name === "Limited" ? [{ repo: "acme/limited", note: "" }] : []) });
    const { prompter, result } = sources(["repo", "Limited", "repo", "vercel/next.js", "done"], llm.client);
    await result;
    expect(prompter.shown).toContain(
      "warn: Could not check 1 candidate for Limited on GitHub; try again later or enter it as owner/repo.",
    );
    expect(prompter.shown.some((s) => s.includes("No GitHub repository found"))).toBe(false);
  });
});

describe("askSources: sites", () => {
  const PAGE = "https://blog.example.com/";
  const page = (links: string) => `<html><head>${links}</head><body>hi</body></html>`;

  it("asks which feed to watch when a page has several", async () => {
    mockFetch({
      [PAGE]: reply.text(
        page(
          '<link rel="alternate" type="application/atom+xml" title="Posts \u001b[2J" href="/posts.atom">' +
            '<link rel="alternate" type="application/rss+xml" title="Comments" href="/comments.rss">',
        ),
      ),
      [`${PAGE}posts.atom`]: reply.text(atom("A post")),
      [`${PAGE}comments.rss`]: reply.text(atom("A comment")),
    });
    const { prompter, result } = sources(["site", PAGE, `${PAGE}posts.atom`, "done"]);
    expect((await result).feeds).toEqual([
      // The page's title for the feed, without control characters, tells it from the comments feed.
      { id: "blog-example-com", type: "rss", name: "blog.example.com: Posts [2J", url: `${PAGE}posts.atom` },
    ]);
    const message = `${PAGE} has 2 feeds; which one?`;
    expect(prompter.options[message]).toEqual([`${PAGE}posts.atom`, `${PAGE}comments.rss`, "none"]);
  });

  it("adds the only feed without asking, and goes back on None of these", async () => {
    mockFetch({
      [PAGE]: reply.text(
        page(
          '<link rel="alternate" type="application/atom+xml" href="/a.atom"><link rel="alternate" type="application/atom+xml" href="/b.atom">',
        ),
      ),
      [`${PAGE}a.atom`]: reply.text(atom("A")),
      [`${PAGE}b.atom`]: reply.text(atom("B")),
      [SIMON]: reply.text(atom("Simon's post")),
    });
    const { prompter, result } = sources(["site", PAGE, "none", "site", SIMON, "done"]);
    expect((await result).feeds!.map((f) => (f.type === "rss" ? f.url : "repo" in f ? f.repo : f.query))).toEqual([SIMON]);
    expect(prompter.asked.filter((m) => m.endsWith("which one?"))).toHaveLength(1);
  });

  it("goes back when a page has no feed or cannot be opened", async () => {
    const fallbacks = ["feed", "feed/", "rss", "rss.xml", "atom.xml", "feed.xml", "index.xml"];
    mockFetch({
      ...BASE_ROUTES,
      [PAGE]: reply.text(page("")),
      ...Object.fromEntries(fallbacks.map((path) => [`${PAGE}${path}`, reply.status(404)])),
      "https://down.example.com/": reply.status(404),
    });
    const { prompter, result } = sources(["site", PAGE, "site", "https://down.example.com/", "site", SIMON, "done"]);
    expect((await result).feeds!.map((f) => (f.type === "rss" ? f.url : "repo" in f ? f.repo : f.query))).toEqual([SIMON]);
    expect(prompter.shown).toContain(`warn: No feed found on ${PAGE}.`);
    expect(prompter.shown.some((s) => s.startsWith("warn: Could not open https://down.example.com/: "))).toBe(true);
  });

  it("names a feed served from another host after the page it was found on", async () => {
    const burner = "https://feeds.feedburner.com/example";
    mockFetch({
      [PAGE]: reply.text(page(`<link rel="alternate" type="application/rss+xml" title="Feed" href="${burner}">`)),
      [burner]: reply.text(atom("A post")),
    });
    const { prompter, result } = sources(["site", PAGE, "done"]);
    expect((await result).feeds).toEqual([{ id: "blog-example-com", type: "rss", name: "blog.example.com", url: burner }]);
  });

  it("offers to add a page that may be up again later, and not one that is gone", async () => {
    // A rate limit asking to wait an hour fails at once instead of being retried.
    const limited = reply.status(429, { "retry-after": "3600" });
    mockFetch({ ...BASE_ROUTES, "https://busy.example.com/feed": [limited, limited], [PAGE]: reply.status(404) });
    const { prompter, result } = sources([
      "site",
      "https://busy.example.com/feed",
      false,
      "site",
      "https://busy.example.com/feed",
      true,
      "site",
      PAGE,
      "site",
      SIMON,
      "done",
      false,
    ]);
    expect((await result).feeds).toEqual([{ id: "simonwillison-net", type: "rss", name: "simonwillison.net/atom/everything", url: SIMON }]);
    expect(prompter.asked.filter((m) => m === "Add https://busy.example.com/feed as a feed anyway?")).toHaveLength(2);
    // Tried like any other source, and rejected here.
    expect(prompter.asked).toContain("Watch busy.example.com/feed anyway?");
    expect(prompter.asked.some((m) => m.startsWith(`Add ${PAGE}`))).toBe(false);
  });

  it("offers to add an advertised feed that failed, not the page that advertised it", async () => {
    const limited = reply.status(429, { "retry-after": "3600" });
    mockFetch({
      [PAGE]: reply.text(page('<link rel="alternate" type="application/rss+xml" href="/feed.xml">')),
      [`${PAGE}feed.xml`]: [limited, limited, reply.text(atom("Back"))],
    });
    const { prompter, result } = sources(["site", PAGE, true, "done", true]);
    expect((await result).feeds).toEqual([
      { id: "blog-example-com", type: "rss", name: "blog.example.com", url: `${PAGE}feed.xml` },
    ]);
    expect(prompter.shown.some((s) => s.startsWith(`warn: Could not check a feed on ${PAGE}: `))).toBe(true);
    expect(prompter.asked).toContain(`Add ${PAGE}feed.xml anyway?`);
  });

  it("does not offer a guessed feed path that failed", async () => {
    const fallbacks = ["feed", "feed/", "rss", "rss.xml", "atom.xml", "feed.xml", "index.xml"];
    const limited = reply.status(429, { "retry-after": "3600" });
    mockFetch({
      ...BASE_ROUTES,
      [PAGE]: reply.text(page("")),
      ...Object.fromEntries(fallbacks.map((path) => [`${PAGE}${path}`, reply.status(404)])),
      [`${PAGE}rss`]: [limited, limited],
    });
    const { prompter, result } = sources(["site", PAGE, "site", SIMON, "done"]);
    expect((await result).feeds!.map((f) => (f.type === "rss" ? f.url : "repo" in f ? f.repo : f.query))).toEqual([SIMON]);
    expect(prompter.shown.some((s) => s.startsWith(`warn: Could not check a feed on ${PAGE}: `))).toBe(true);
    expect(prompter.asked.some((m) => m.endsWith("anyway?"))).toBe(false);
  });

  it("rejects URLs that are not absolute http(s)", async () => {
    for (const url of ["simonwillison.net", "ftp://example.com/feed", "/feed.xml"]) {
      expect(await rejection(sources(["site", url]).result)).toMatchObject({ message: expect.stringMatching(/http\(s\) URL/) });
    }
  });

  it("treats feed URLs that normalize the same as one feed", async () => {
    const other = "https://example.com/feed/?utm_source=x#top";
    const fetch = mockFetch({ "https://example.com/feed": reply.text(atom("A")), [other]: reply.text(atom("A")) });
    const { prompter, result } = sources(["site", "https://example.com/feed", "site", other, "done"]);
    expect((await result).feeds).toEqual([
      { id: "example-com", type: "rss", name: "example.com/feed", url: "https://example.com/feed" },
    ]);
    expect(prompter.shown).toContain("warn: Already added; skipped.");
    // Known before it is fetched.
    expect(fetch.callsTo(other)).toEqual([]);
  });
});

describe("askSources: searches", () => {
  const news = (query: string, extra: Partial<GoogleNewsFeed> = {}) =>
    ({ id: queryIdFrom(query, new Set()), type: "googlenews", query, locale: "en-US", ...extra }) as const;
  const route = (...feeds: GoogleNewsFeed[]) =>
    Object.fromEntries(feeds.map((f) => [googleNewsUrl(f), reply.text(atom(`About ${f.query}`))]));

  it("offers Claude's suggestions as free news searches without a Tavily key, five at most", async () => {
    mockFetch(route(news("Qwen release"), news("B")));
    const llm = fakeLlm({ queries: () => ["Qwen release", " qwen  release ", "", "A", "B", "C", "D", "E"] });
    const { prompter, result } = sources(["done", ["Qwen release", "B"]], llm.client);
    expect(await result).toEqual({ version: 1, feeds: [news("Qwen release"), news("B")] });
    expect(prompter.options[NEWS]).toEqual(["Qwen release", "A", "B", "C", "D"]);
    // Suggestions from Claude are not picked for the user.
    expect(prompter.initial[NEWS]).toEqual([]);
    // Both brought news, so neither is asked about again.
    expect(prompter.asked.some((m) => m.startsWith("Watch "))).toBe(false);
    expect(prompter.asked).not.toContain(WEB);
  });

  it("takes a news search typed from the menu, kept to the sites given", async () => {
    const feed = news("Qwen release", { sites: ["prtimes.jp", "news.example.com"] });
    mockFetch(route(feed));
    const answers = ["news", "  Qwen   release ", "prtimes.jp, News.example.com", "done"];
    const { result } = sources(answers);
    expect((await result).feeds).toEqual([feed]);
    expect(await rejection(sources(["news", "Qwen", "https://prtimes.jp"]).result)).toMatchObject({
      message: expect.stringMatching(/rejected "https:\/\/prtimes.jp"/),
    });
  });

  it("says what web searches cost before taking any, and only with a Tavily key", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({ [TAVILY]: reply.text(await readFile(TAVILY_FIXTURE, "utf8")) });
    const prompter = scriptedPrompter(["done", " Qwen \t LoRA ", "\u001b\u0007", "qwen lora", "", true]);
    const session = newSession(prompter, CONTEXT, { env: { TAVILY_API_KEY: "tvly-test" }, runsPerMonth: 9 });
    const result = await askSources(session);
    expect(result.queries).toEqual([{ id: "qwen-lora", query: "Qwen LoRA", topic: "general" }]);
    expect(prompter.shown).toContain(
      "note: Tavily: Web searches run on Tavily, a paid search API: each one costs a credit on every run (about 9 credits a month each at this schedule), and one now to try it. The free plan has 1000 credits a month, so add only what a news search cannot find.",
    );
    expect(prompter.shown).toContain("note: Tavily: 1 web search: about 9 Tavily credits a month.");
    // Typed web searches are compared and stored as the suggestions are.
    expect(prompter.shown).toContain("warn: Already added: qwen lora; skipped.");
  });

  it("warns when the web searches would cost more than the free plan", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({ [TAVILY]: [reply.json({ results: [] }), reply.json({ results: [] })] });
    const prompter = scriptedPrompter(["done", "a", "b", "", true, true]);
    await askSources(newSession(prompter, CONTEXT, { env: { TAVILY_API_KEY: "tvly-test" }, runsPerMonth: 600 }));
    expect(prompter.shown).toContain(
      "warn: 2 web searches: about 1200 Tavily credits a month. That is more than the 1000 the free plan has.",
    );
  });

  it("reads the Tavily key from the env it is given", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const prompter = scriptedPrompter(["done"]);
    const result = askSources(newSession(prompter, CONTEXT, { env: {} }));
    expect(await rejection(result)).toMatchObject({ message: expect.stringMatching(/not an option/) });
  });

  it("goes on without suggestions when Claude cannot give any", async () => {
    mockFetch(route(news("Qwen")));
    const llm = fakeLlm({
      queries: () => {
        throw new LlmError("invalid_output", "bad");
      },
    });
    const { prompter, result } = sources(["news", "Qwen", "", "done"], llm.client);
    expect((await result).feeds!.map((f) => ("query" in f ? f.query : f.name))).toEqual(["Qwen"]);
    expect(prompter.shown).toContain("warn: Claude could not answer (invalid_output).");
  });
});

describe("askSources: trial fetch", () => {
  it("shows the latest item of each source without control characters", async () => {
    mockFetch(repoRoutes("vercel/next.js", { releases: [release("\u001b]0;pwned\u0007v16 \u001b[31mred")] }));
    const { prompter, result } = sources(["repo", "vercel/next.js", "done"]);
    await result;
    const shown = prompter.shown.find((s) => s.startsWith("note: vercel/next.js (github): "))!;
    expect(shown).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(shown).toContain("v16 [31mred");
  });

  it("drops rejected sources and asks again when nothing is left", async () => {
    mockFetch({ ...BASE_ROUTES, [SIMON]: [reply.text(atom("ok")), reply.status(410)] });
    const { prompter, result } = sources([
      "site",
      QUIET,
      "site",
      SIMON,
      "done",
      false,
      false,
      // The rejected ones can be added again.
      "site",
      QUIET,
      "done",
      true,
    ]);
    expect((await result).feeds!.map((f) => (f.type === "rss" ? f.url : f.id))).toEqual([QUIET]);
    expect(prompter.shown).toContain("warn: Nothing to watch yet; add a source.");
  });

  it("reports a failing source and keeps it only when the user says so", async () => {
    mockFetch({ ...BASE_ROUTES, [SIMON]: [reply.text(atom("ok")), reply.status(410)] });
    const { prompter, result } = sources(["repo", "vercel/next.js", "site", SIMON, "done", false]);
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js"]);
    expect(prompter.shown.some((s) => s.startsWith("warn: simonwillison.net/atom/everything (rss) failed: "))).toBe(true);
    expect(prompter.asked).toEqual(expect.arrayContaining(["Watch simonwillison.net/atom/everything anyway?"]));
    expect(prompter.asked).not.toContain("Watch vercel/next.js anyway?");
  });

  it("notes a source with no items yet and asks whether to keep it", async () => {
    const { prompter, result } = sources(["site", QUIET, "done", true]);
    expect((await result).feeds).toHaveLength(1);
    expect(prompter.shown).toContain("note: quiet.example.com/feed (rss): No items yet.");
    expect(prompter.asked).toContain("Watch quiet.example.com/feed anyway?");
  });

  it("shows what GitHub returned while checking a repository instead of asking again", async () => {
    const fetch = mockFetch(repoRoutes("vercel/next.js"));
    const { prompter, result } = sources(["repo", "vercel/next.js", "done"]);
    await result;
    expect(fetch.callsTo(`${API}/vercel/next.js/releases?per_page=100`)).toHaveLength(1);
    expect(prompter.shown.some((s) => s.startsWith("spin: Fetching"))).toBe(false);
    expect(prompter.asked.some((m) => m.startsWith("Watch "))).toBe(false);
    expect(prompter.shown).toContain("note: vercel/next.js (github): v16.0.0\n2026-10-24\nhttps://github.com/x/y/releases/tag/v16.0.0");
  });

  it("follows a repository whose tags are all prereleases", async () => {
    const rc = atom("v2.0.0-rc.1", "https://github.com/acme/quiet/releases/tag/v2.0.0-rc.1");
    mockFetch({ ...repoRoutes("acme/quiet", { releases: [] }), "https://github.com/acme/quiet/tags.atom": reply.text(rc) });
    const { prompter, result } = sources(["repo", "acme/quiet", "done"]);
    expect((await result).feeds![0]).toMatchObject({ feed: "tags", includePrereleases: true });
    expect(prompter.shown).toContain("note: acme/quiet has only prereleases so far; following them.");
    expect(prompter.shown.some((s) => s.startsWith("note: acme/quiet (github): v2.0.0-rc.1"))).toBe(true);
  });
});
