import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Impact } from "../../src/config/schema.js";
import {
  buildSlackMessages,
  escapeMrkdwn,
  MAX_BLOCKS,
  MAX_FALLBACK_POSTS,
  MAX_MESSAGE_CHARS,
  MAX_SECTION_CHARS,
  sendSlack,
  type Briefing,
  type SlackMessage,
} from "../../src/notifiers/slack.js";
import type { Insight } from "../../src/types.js";
import { HttpError } from "../../src/util/http.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { mockFetch, reply } from "../helpers/mockFetch.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secretsecretsecret";

function insight(n: number, overrides: Partial<Omit<Insight, "item">> & { url?: string } = {}): Insight {
  const { url, ...rest } = overrides;
  return {
    item: {
      id: `id${n}`,
      sourceId: "nextjs",
      sourceName: "Next.js releases",
      kind: "github",
      title: `Original ${n}`,
      url: url ?? `https://example.com/posts/${n}`,
      urlKey: `key${n}`,
      content: "",
    },
    title: `Title ${n}`,
    summary: `Summary ${n}`,
    impact: "Medium",
    action: `Action ${n}`,
    ...rest,
  };
}

function briefing(insights: Insight[], overrides: Partial<Briefing> = {}): Briefing {
  return { project: "my-app", date: "2026-10-26", insights, collected: 120, attempted: 8, failedSources: [], ...overrides };
}

const many = (n: number) => Array.from({ length: n }, (_, i) => insight(i + 1));

interface Block {
  type: string;
  text?: { type: string; text: string };
  elements?: { type: string; text: string }[];
}

const blocks = (m: SlackMessage) => m.payload.blocks as Block[];
const sections = (m: SlackMessage) => blocks(m).filter((b) => b.type === "section").map((b) => b.text!.text);
const header = (m: SlackMessage) => blocks(m)[0]!.text!.text;
const context = (m: SlackMessage) => blocks(m).at(-1)!.elements![0]!.text;

function only(b: Briefing): SlackMessage {
  const messages = buildSlackMessages(b, { postWhenEmpty: false });
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

let logged: string[];

beforeEach(() => {
  logged = [];
  configureLog({ write: (s) => logged.push(s) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetLog();
});

describe("escapeMrkdwn", () => {
  it("escapes &, < and > without escaping twice", () => {
    expect(escapeMrkdwn("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeMrkdwn("&lt;")).toBe("&amp;lt;");
  });

  it("neutralizes mentions and links smuggled into the text", () => {
    const text = sections(only(briefing([insight(1, { summary: "<!channel> see <https://evil.example|docs>" })])))[0]!;
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<https://evil");
    expect(text).toContain("&lt;!channel&gt; see &lt;https://evil.example|docs&gt;");
  });

  it("keeps | out of the link label and the URL", () => {
    const f = insight(1, { title: "A | B > C", url: "https://example.com/a|b?x=1&y=2" });
    const head = sections(only(briefing([f])))[0]!.split("\n")[0]!;
    expect(head).toBe(":large_orange_circle: *[Medium]* <https://example.com/a%7Cb?x=1&amp;y=2|A ｜ B &gt; C>");
  });
});

describe("buildSlackMessages", () => {
  it("matches the payload for two insights", () => {
    const insights = [
      insight(1, { impact: "High", title: "Next.js 17 drops the pages router", summary: "Breaking.\nMigrate now." }),
      insight(2, { impact: "Low", title: "Release notes", action: "" }),
    ];
    expect(buildSlackMessages(briefing(insights), { postWhenEmpty: false })).toMatchSnapshot();
  });

  it("formats an insight with emoji, impact, link, summary, action and source", () => {
    const emoji: Record<Impact, string> = { High: ":red_circle:", Medium: ":large_orange_circle:", Low: ":large_blue_circle:" };
    for (const impact of ["High", "Medium", "Low"] as const) {
      expect(sections(only(briefing([insight(1, { impact })])))[0]).toBe(
        `${emoji[impact]} *[${impact}]* <https://example.com/posts/1|Title 1>\nSummary 1\n*Action:* Action 1\n_Next.js releases_`,
      );
    }
  });

  it("splits 100 insights into 45, 45 and 10, keeping the order", () => {
    const messages = buildSlackMessages(briefing(many(100)), { postWhenEmpty: false });
    expect(messages.map((m) => m.itemIds.length)).toEqual([45, 45, 10]);
    expect(messages.flatMap((m) => m.itemIds)).toEqual(many(100).map((f) => f.item.id));
    expect(messages.map(header)).toEqual([
      "Pochi · my-app · 2026-10-26 (1/3)",
      "Pochi · my-app · 2026-10-26 (2/3)",
      "Pochi · my-app · 2026-10-26 (3/3)",
    ]);
    expect(messages.map((m) => m.payload.text)).toEqual([
      "Pochi: 100 updates for my-app (1/3)",
      "Pochi: 100 updates for my-app (2/3)",
      "Pochi: 100 updates for my-app (3/3)",
    ]);
    for (const m of messages) expect(context(m)).toBe("Collected 120 items from 8 sources");
  });

  it("adds no part number to a single message and counts High insights in the text", () => {
    const m = only(briefing([insight(1, { impact: "High" }), insight(2)], { project: "a&b" }));
    expect(header(m)).toBe("Pochi · a&b · 2026-10-26");
    expect(m.payload.text).toBe("Pochi: 2 updates for a&amp;b (1 High)");
  });

  it("stays within the block limit", () => {
    const [first] = buildSlackMessages(briefing(many(46)), { postWhenEmpty: false });
    expect(blocks(first!).map((b) => b.type)).toEqual(["header", ...Array(45).fill("section"), "context"]);
    expect(blocks(first!).length).toBeLessThanOrEqual(MAX_BLOCKS);
  });

  it("caps the header at 150 characters, keeping the part number", () => {
    const messages = buildSlackMessages(briefing(many(46), { project: "x".repeat(200) }), { postWhenEmpty: false });
    const text = header(messages[0]!);
    expect(text.length).toBeLessThanOrEqual(150);
    expect(text.endsWith("… (1/2)")).toBe(true);
  });

  it("cuts a long summary first and keeps the action", () => {
    const text = sections(only(briefing([insight(1, { summary: "s".repeat(5000) })])))[0]!;
    expect(text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    expect(text).toContain("s…\n*Action:* Action 1\n_Next.js releases_");
  });

  it("gives the action at least half of the room when both are long", () => {
    const text = sections(only(briefing([insight(1, { summary: "s".repeat(5000), action: "a".repeat(5000) })])))[0]!;
    expect(text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    const [, summary, action] = text.split("\n");
    expect(summary!.length).toBeGreaterThan(1000);
    expect(action!.length).toBeGreaterThan(1000);
    expect(text.endsWith("…\n_Next.js releases_")).toBe(true);
  });

  it("measures the limit after escaping and never cuts inside an entity", () => {
    const text = sections(only(briefing([insight(1, { summary: "&".repeat(3000) })])))[0]!;
    expect(text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    const summary = text.split("\n")[1]!;
    expect(summary).toMatch(/^(&amp;)+…$/);
  });

  it("cuts emoji and Japanese by code point", () => {
    const text = sections(only(briefing([insight(1, { summary: "🎉日本語".repeat(2000) })])))[0]!;
    expect(text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text).toContain("…\n*Action:*");
  });

  it("drops the query of a long URL, and the link when the URL is still too long", () => {
    const query = `https://example.com/a?utm=${"x".repeat(3500)}`;
    const queryText = sections(only(briefing([insight(1, { url: query })])))[0]!;
    expect(queryText.split("\n")[0]).toBe(":large_orange_circle: *[Medium]* <https://example.com/a|Title 1>");

    const path = `https://example.com/${"p".repeat(3500)}`;
    const pathText = sections(only(briefing([insight(1, { url: path, summary: "s".repeat(5000) })])))[0]!;
    expect(pathText.split("\n")[0]).toBe(":large_orange_circle: *[Medium]* *Title 1*");
    expect(pathText.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
  });

  it("keeps the section text of a message within MAX_MESSAGE_CHARS", () => {
    const long = Array.from({ length: 45 }, (_, i) => insight(i + 1, { summary: "要".repeat(3000), action: "a".repeat(3000) }));
    const messages = buildSlackMessages(briefing(long), { postWhenEmpty: false });
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) {
      expect(sections(m).join("").length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
    expect(messages.flatMap((m) => m.itemIds)).toEqual(long.map((f) => f.item.id));
    expect(header(messages.at(-1)!)).toBe(`Pochi · my-app · 2026-10-26 (${messages.length}/${messages.length})`);
  });

  it("leaves out an empty summary and keeps the title and source on one line", () => {
    const f = insight(1, { title: "Line one\nline two", summary: "  ", action: "" });
    f.item.sourceName = "Next.js\nreleases";
    expect(sections(only(briefing([f])))[0]).toBe(
      ":large_orange_circle: *[Medium]* <https://example.com/posts/1|Line one line two>\n_Next.js releases_",
    );
  });

  it("lists the failed sources in the footer, escaped and within 3000 characters", () => {
    const m = only(briefing([insight(1)], { collected: 1, attempted: 1, failedSources: ["A<B", "C"] }));
    expect(context(m)).toBe("Collected 1 item from 1 source · Failed: A&lt;B, C");

    const failedSources = Array.from({ length: 500 }, (_, i) => `Source number ${i}`);
    const long = context(only(briefing([insight(1)], { failedSources })));
    expect(long.length).toBeLessThanOrEqual(3000);
    expect(long.endsWith("…")).toBe(true);
  });

  it("sends nothing for no insights unless postWhenEmpty is on", () => {
    expect(buildSlackMessages(briefing([]), { postWhenEmpty: false })).toEqual([]);
    const messages = buildSlackMessages(briefing([]), { postWhenEmpty: true });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.itemIds).toEqual([]);
    expect(messages[0]!.payload.text).toBe("Pochi: no relevant updates for my-app");
    expect(sections(messages[0]!)).toEqual(["No relevant updates today."]);
    expect(context(messages[0]!)).toBe("Collected 120 items from 8 sources");
  });
});

describe("sendSlack", () => {
  const messages = () => buildSlackMessages(briefing(many(100)), { postWhenEmpty: false });
  const ids = (from: number, to: number) => many(to).slice(from).map((f) => f.item.id);
  const ok = reply.text("ok");
  const rateLimited = reply.status(429, { "retry-after": "0" });

  it("posts every message as JSON and returns every id", async () => {
    const mock = mockFetch({ [WEBHOOK]: ok });
    const result = await sendSlack(WEBHOOK, messages(), { intervalMs: 0 });

    expect(result).toEqual({ deliveredIds: ids(0, 100), failures: [], aborted: false });
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[0]!.method).toBe("POST");
    expect(mock.calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual(messages()[0]!.payload);
  });

  it("retries a 429 up to three times", async () => {
    const mock = mockFetch({ [WEBHOOK]: [rateLimited, rateLimited, ok] });
    const [first] = messages();
    expect((await sendSlack(WEBHOOK, [first!], { intervalMs: 0 })).deliveredIds).toEqual(ids(0, 45));
    expect(mock.calls).toHaveLength(3);
  });

  it("gives up after a fourth 429 and sends nothing more", async () => {
    const mock = mockFetch({ [WEBHOOK]: [rateLimited, rateLimited, rateLimited, rateLimited] });
    const result = await sendSlack(WEBHOOK, messages(), { intervalMs: 0 });

    expect(mock.calls).toHaveLength(4);
    expect(result.deliveredIds).toEqual([]);
    expect(result.failures.map((f) => f.index)).toEqual([0, 1, 2]);
    expect((result.failures[0]!.error as HttpError).status).toBe(429);
  });

  it("narrows a 400 down to the insight Slack rejects and delivers the rest", async () => {
    const bad = "https://example.com/posts/57";
    const mock = mockFetch({ [WEBHOOK]: (req) => (req.body!.includes(bad) ? reply.status(400) : ok)(req, undefined) });
    const result = await sendSlack(WEBHOOK, messages(), { intervalMs: 0 });

    // The second message is halved down to the one insight, which then goes out bare.
    expect(result.deliveredIds.sort()).toEqual(ids(0, 100).sort());
    expect(result.failures).toEqual([]);
    const last = JSON.parse(mock.calls.findLast((c) => c.body!.includes("Title 57"))!.body!);
    expect(sections({ payload: last, itemIds: [] })).toEqual([":large_orange_circle: *[Medium]* *Title 57*\n_Next.js releases_"]);
    expect(mock.calls.length).toBeLessThanOrEqual(3 + 12);
    expect(logged.join("")).toContain("retrying Slack message 2/3 as 2 smaller messages");
  });

  it("records an insight whose bare entry is rejected too and goes on to the next message", async () => {
    const mock = mockFetch({ [WEBHOOK]: (req) => (req.body!.includes("Title 57") ? reply.status(400) : ok)(req, undefined) });
    const result = await sendSlack(WEBHOOK, messages(), { intervalMs: 0 });

    expect(result.failures.map((f) => [f.index, f.itemIds])).toEqual([[1, ["id57"]]]);
    expect((result.failures[0]!.error as HttpError).status).toBe(400);
    expect(result.deliveredIds).toHaveLength(99);
    expect(result.deliveredIds).toEqual(expect.arrayContaining(ids(90, 100)));
    expect(mock.calls.at(-1)!.body).toContain("Title 100");
  });

  it("stops splitting after MAX_FALLBACK_POSTS when every piece is rejected", async () => {
    const mock = mockFetch({ [WEBHOOK]: reply.status(400) });
    const result = await sendSlack(WEBHOOK, messages(), { intervalMs: 0 });

    expect(result.deliveredIds).toEqual([]);
    expect(result.failures.flatMap((f) => f.itemIds).sort()).toEqual(ids(0, 100).sort());
    expect(mock.calls.length).toBeLessThanOrEqual(3 + MAX_FALLBACK_POSTS);
  });

  it("stops at a dead webhook and returns only what was delivered", async () => {
    const mock = mockFetch({ [WEBHOOK]: [ok, reply.status(404)] });
    const result = await sendSlack(WEBHOOK, messages(), { intervalMs: 0 });

    expect(mock.calls).toHaveLength(2);
    expect(result.deliveredIds).toEqual(ids(0, 45));
    expect(result.failures.map((f) => f.index)).toEqual([1, 2]);
    expect(logged.join("")).toContain("Slack message 2/3 was not delivered: HTTP 404");
    expect(logged.join("")).toContain("skipped the remaining 1 Slack message");
  });

  it("retries a 5xx once", async () => {
    const mock = mockFetch({ [WEBHOOK]: [reply.status(500), ok] });
    vi.useFakeTimers();
    const pending = sendSlack(WEBHOOK, [messages()[0]!], { intervalMs: 0 });
    await vi.runAllTimersAsync();
    expect((await pending).deliveredIds).toEqual(ids(0, 45));
    expect(mock.calls).toHaveLength(2);
  });

  it("waits 1.1 seconds between messages", async () => {
    const mock = mockFetch({ [WEBHOOK]: ok });
    vi.useFakeTimers();
    const pending = sendSlack(WEBHOOK, messages().slice(0, 2));
    await vi.advanceTimersByTimeAsync(1099);
    expect(mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.calls).toHaveLength(2);
    expect((await pending).deliveredIds).toEqual(ids(0, 90));
  });

  it("returns what was delivered when aborted during a request", async () => {
    mockFetch({ [WEBHOOK]: reply.hang() });
    const controller = new AbortController();
    const pending = sendSlack(WEBHOOK, messages(), { signal: controller.signal, intervalMs: 0 });
    controller.abort(new Error("stop"));
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.deliveredIds).toEqual([]);
    expect(result.failures.map((f) => f.index)).toEqual([0, 1, 2]);
  });

  it("returns what was delivered when aborted between messages", async () => {
    const mock = mockFetch({ [WEBHOOK]: ok });
    const controller = new AbortController();
    vi.useFakeTimers();
    const pending = sendSlack(WEBHOOK, messages(), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1100);
    expect(mock.calls).toHaveLength(2);
    controller.abort(new Error("stop"));
    const result = await pending;

    expect(result).toMatchObject({ deliveredIds: ids(0, 90), aborted: true });
    expect(result.failures.map((f) => [f.index, f.itemIds])).toEqual([[2, ids(90, 100)]]);
    expect(mock.calls).toHaveLength(2);
  });

  it("keeps the webhook out of the logs", async () => {
    mockFetch({ [WEBHOOK]: reply.status(403) });
    await sendSlack(WEBHOOK, messages(), { intervalMs: 0 });
    expect(logged.join("")).toContain("HTTP 403 for https://hooks.slack.com/***");

    logged = [];
    vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK);
    await sendSlack(WEBHOOK, messages(), { intervalMs: 0 });
    expect(logged.join("")).toContain("HTTP 403 for ***");
    expect(logged.join("")).not.toContain("secretsecret");
  });
});
