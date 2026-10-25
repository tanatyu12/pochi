import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, fetchText, parseRetryAfter, postJson } from "../../src/util/http.js";
import { VERSION } from "../../src/version.js";
import { type Reply, mockFetch, reply } from "../helpers/mockFetch.js";

const URL_A = "https://a.test/feed";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Settles the promise into a value so a rejection is never left unhandled while timers advance.
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

async function expectHttpError(p: Promise<unknown>, expected: Partial<HttpError>): Promise<HttpError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject(expected);
  return err as HttpError;
}

describe("fetchText", () => {
  it("returns the body, status and final URL", async () => {
    mockFetch({ [URL_A]: reply.redirect("https://b.test/feed.xml", "<rss/>") });
    const res = await fetchText(URL_A);
    expect(res).toMatchObject({ url: "https://b.test/feed.xml", status: 200, text: "<rss/>" });
  });

  it("falls back to the requested URL when the response has none", async () => {
    mockFetch({ [URL_A]: reply.text("ok") });
    expect((await fetchText(URL_A)).url).toBe(URL_A);
  });

  it("sends a User-Agent and lets callers add headers", async () => {
    const fm = mockFetch({ [URL_A]: reply.text("ok") });
    await fetchText(URL_A, { headers: { Accept: "application/atom+xml" } });
    expect(fm.calls[0]?.headers.get("user-agent")).toBe(`pochi/${VERSION}`);
    expect(fm.calls[0]?.headers.get("accept")).toBe("application/atom+xml");
  });

  it.each(["ftp://a.test/x", "file:///etc/passwd", "javascript:alert(1)", "not a url"])(
    "rejects %s without calling fetch",
    async (url) => {
      const fm = mockFetch({});
      await expectHttpError(fetchText(url), { kind: "invalid_url" });
      expect(fm.calls).toHaveLength(0);
    },
  );

  describe("decoding", () => {
    it("strips a UTF-8 BOM", async () => {
      mockFetch({ [URL_A]: reply.bytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<rss/>")])) });
      expect((await fetchText(URL_A)).text).toBe("<rss/>");
    });

    it("strips a BOM split across chunks", async () => {
      mockFetch({ [URL_A]: reply.stream([new Uint8Array([0xef, 0xbb]), new Uint8Array([0xbf]), "<rss/>"]) });
      expect((await fetchText(URL_A)).text).toBe("<rss/>");
    });

    it("decodes the charset declared in Content-Type", async () => {
      // "日本" in Shift_JIS.
      const body = new Uint8Array([0x93, 0xfa, 0x96, 0x7b]);
      mockFetch({ [URL_A]: reply.bytes(body, { headers: { "content-type": "text/html; charset=Shift_JIS" } }) });
      expect((await fetchText(URL_A)).text).toBe("日本");
    });

    it("falls back to UTF-8 for an unknown charset", async () => {
      mockFetch({ [URL_A]: reply.text("日本", { headers: { "content-type": "text/html; charset=bogus" } }) });
      expect((await fetchText(URL_A)).text).toBe("日本");
    });
  });

  describe("size limit", () => {
    it("fails early when Content-Length exceeds the limit", async () => {
      mockFetch({ [URL_A]: reply.text("x".repeat(11), { headers: { "content-length": "11" } }) });
      await expectHttpError(fetchText(URL_A, { maxBytes: 10 }), { kind: "too_large" });
    });

    it("fails while streaming when there is no Content-Length", async () => {
      mockFetch({ [URL_A]: reply.stream(["12345", "678901"]) });
      await expectHttpError(fetchText(URL_A, { maxBytes: 10 }), { kind: "too_large" });
    });

    it("accepts a body of exactly the limit", async () => {
      mockFetch({ [URL_A]: reply.stream(["12345", "67890"]) });
      expect((await fetchText(URL_A, { maxBytes: 10 })).text).toBe("1234567890");
    });

    it("does not retry", async () => {
      const fm = mockFetch({ [URL_A]: reply.stream(["12345678901"]) });
      await expectHttpError(fetchText(URL_A, { maxBytes: 10 }), { kind: "too_large" });
      expect(fm.calls).toHaveLength(1);
    });
  });

  describe("timeout", () => {
    it("fails with kind timeout", async () => {
      const fm = mockFetch({ [URL_A]: reply.hang() });
      await expectHttpError(fetchText(URL_A, { timeoutMs: 20, retry: { server: 0 } }), { kind: "timeout" });
      expect(fm.calls).toHaveLength(1);
    });

    it("covers reading the body", async () => {
      const stalled: Reply = (_req, signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<rss>"));
              signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
            },
          }),
        );
      mockFetch({ [URL_A]: stalled });
      await expectHttpError(fetchText(URL_A, { timeoutMs: 20, retry: { server: 0 } }), { kind: "timeout" });
    });

    it("retries once after a timeout", async () => {
      const fm = mockFetch({ [URL_A]: [reply.hang(), reply.text("ok")] });
      expect((await fetchText(URL_A, { timeoutMs: 20 })).text).toBe("ok");
      expect(fm.calls).toHaveLength(2);
    });

    it("passes a caller abort through without retrying", async () => {
      const fm = mockFetch({ [URL_A]: reply.hang() });
      const controller = new AbortController();
      const p = fetchText(URL_A, { signal: controller.signal });
      controller.abort(new Error("cancelled"));
      await expect(p).rejects.toThrow("cancelled");
      expect(fm.calls).toHaveLength(1);
    });
  });

  describe("retries", () => {
    it("does not retry 404", async () => {
      const fm = mockFetch({ [URL_A]: reply.status(404) });
      await expectHttpError(fetchText(URL_A), { kind: "status", status: 404 });
      expect(fm.calls).toHaveLength(1);
    });

    it("does not retry other 4xx", async () => {
      const fm = mockFetch({ [URL_A]: reply.status(401) });
      await expectHttpError(fetchText(URL_A), { kind: "status", status: 401 });
      expect(fm.calls).toHaveLength(1);
    });

    it("retries a 5xx once after one second", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fm = mockFetch({ [URL_A]: [reply.status(503), reply.text("ok")] });
      const result = settle(fetchText(URL_A));
      await vi.advanceTimersByTimeAsync(999);
      expect(fm.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ ok: true, value: { text: "ok" } });
      expect(fm.calls).toHaveLength(2);
    });

    it("gives up after the second 5xx", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fm = mockFetch({ [URL_A]: reply.status(500) });
      const result = settle(fetchText(URL_A));
      await vi.runAllTimersAsync();
      const outcome = await result;
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.error).toMatchObject({ kind: "status", status: 500 });
      expect(fm.calls).toHaveLength(2);
    });

    it("retries a network error once", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fm = mockFetch({ [URL_A]: [reply.networkError(), reply.text("ok")] });
      const result = settle(fetchText(URL_A));
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ ok: true });
      expect(fm.calls).toHaveLength(2);
    });

    it("reports a persistent network error with its cause", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mockFetch({ [URL_A]: reply.networkError("ECONNRESET") });
      const result = settle(fetchText(URL_A));
      await vi.runAllTimersAsync();
      const outcome = await result;
      expect(!outcome.ok && outcome.error).toMatchObject({ kind: "network", cause: { message: "ECONNRESET" } });
    });

    it("puts the underlying reason of a fetch failure in the message", async () => {
      mockFetch({
        [URL_A]: () => {
          throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND a.test") });
        },
      });
      const err = await expectHttpError(fetchText(URL_A, { retry: { server: 0 } }), { kind: "network" });
      expect(err.message).toBe(`request failed: ${URL_A}: getaddrinfo ENOTFOUND a.test`);
    });

    it("waits for Retry-After on 429", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fm = mockFetch({ [URL_A]: [reply.status(429, { "retry-after": "2" }), reply.text("ok")] });
      const result = settle(fetchText(URL_A));
      await vi.advanceTimersByTimeAsync(1999);
      expect(fm.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ ok: true });
    });

    it("gives up at once when Retry-After exceeds 30 seconds", async () => {
      const fm = mockFetch({ [URL_A]: [reply.status(429, { "retry-after": "120" }), reply.text("ok")] });
      await expectHttpError(fetchText(URL_A), { status: 429, retryAfterMs: 120_000 });
      expect(fm.calls).toHaveLength(1);
    });

    it("waits for a Retry-After of exactly 30 seconds", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fm = mockFetch({ [URL_A]: [reply.status(429, { "retry-after": "30" }), reply.text("ok")] });
      const result = settle(fetchText(URL_A));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ ok: true });
      expect(fm.calls).toHaveLength(2);
    });

    it("waits one second when 429 has no Retry-After", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fm = mockFetch({ [URL_A]: [reply.status(429), reply.text("ok")] });
      const result = settle(fetchText(URL_A));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ ok: true });
      expect(fm.calls).toHaveLength(2);
    });

    it("retries 429 once by default", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fm = mockFetch({ [URL_A]: reply.status(429, { "retry-after": "1" }) });
      const result = settle(fetchText(URL_A));
      await vi.runAllTimersAsync();
      const outcome = await result;
      expect(!outcome.ok && outcome.error).toMatchObject({ kind: "status", status: 429, retryAfterMs: 1000 });
      expect(fm.calls).toHaveLength(2);
    });

    it("honours a larger rate-limit retry budget", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const limited = reply.status(429, { "retry-after": "1" });
      const fm = mockFetch({ [URL_A]: [limited, limited, limited, reply.text("ok")] });
      const result = settle(fetchText(URL_A, { retry: { rateLimit: 3 } }));
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ ok: true });
      expect(fm.calls).toHaveLength(4);
    });
  });
});

describe("postJson", () => {
  it("sends JSON with a Content-Type header", async () => {
    const fm = mockFetch({ [URL_A]: reply.text("ok") });
    await postJson(URL_A, { text: "hi" }, { headers: { Authorization: "Bearer x" } });
    const req = fm.calls[0];
    expect(req?.method).toBe("POST");
    expect(req?.body).toBe('{"text":"hi"}');
    expect(req?.headers.get("content-type")).toBe("application/json");
    expect(req?.headers.get("authorization")).toBe("Bearer x");
  });

  it.each([
    ["5xx", reply.status(503)],
    ["a network error", reply.networkError()],
  ])("does not resend after %s by default", async (_, failure) => {
    const fm = mockFetch({ [URL_A]: [failure, reply.text("ok")] });
    await expectHttpError(postJson(URL_A, {}), {});
    expect(fm.calls).toHaveLength(1);
  });

  it("resends when the caller opts in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fm = mockFetch({ [URL_A]: [reply.status(503), reply.text("ok")] });
    const result = settle(postJson(URL_A, {}, { retry: { server: 1 } }));
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ ok: true });
    expect(fm.calls).toHaveLength(2);
  });

  it("keeps the webhook URL out of error messages", async () => {
    const webhook = "https://hooks.slack.com/services/T000/B000/XXXXSECRET";
    mockFetch({ [webhook]: reply.status(400) });
    const err = await expectHttpError(postJson(webhook, {}), { status: 400 });
    expect(err.message).not.toContain("XXXXSECRET");
    expect(err.url).not.toContain("XXXXSECRET");
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");

  it.each([
    [null, undefined],
    ["", undefined],
    ["5", 5000],
    [" 0 ", 0],
    ["Sun, 25 Oct 2026 00:00:10 GMT", 10_000],
    ["Sat, 24 Oct 2026 23:59:00 GMT", 0],
    ["soon", undefined],
  ])("parses %j as %j", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});
