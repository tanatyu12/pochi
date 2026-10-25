import { vi } from "vitest";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

/** Produces the outcome of one fetch call: a Response, or a thrown error. */
export type Reply = (req: RecordedRequest, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** A route is one reply (reused for every call) or a list consumed in order. */
export type Route = Reply | Reply[];

export const reply = {
  text:
    (body: string, init: ResponseInit = {}): Reply =>
    () =>
      new Response(body, init),
  json:
    (value: unknown, init: ResponseInit = {}): Reply =>
    () =>
      Response.json(value, init),
  status:
    (status: number, headers?: Record<string, string>): Reply =>
    () =>
      new Response(null, { status, headers }),
  bytes:
    (body: Uint8Array, init: ResponseInit = {}): Reply =>
    () =>
      new Response(body, init),
  /** A body without Content-Length, delivered chunk by chunk. */
  stream:
    (chunks: (string | Uint8Array)[], init: ResponseInit = {}): Reply =>
    () => {
      const encoder = new TextEncoder();
      const queue = [...chunks];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = queue.shift();
          if (chunk === undefined) controller.close();
          else controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
      });
      return new Response(body, init);
    },
  /** The response as it looks after fetch followed redirects to finalUrl. */
  redirect:
    (finalUrl: string, body: string, init: ResponseInit = {}): Reply =>
    () => {
      const res = new Response(body, init);
      Object.defineProperty(res, "url", { value: finalUrl });
      return res;
    },
  networkError:
    (message = "fetch failed"): Reply =>
    () => {
      throw new TypeError(message);
    },
  /** Never answers; rejects only when the request is aborted. */
  hang: (): Reply => (_req, signal) =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
};

export interface FetchMock {
  calls: RecordedRequest[];
  /** Calls made to one URL. */
  callsTo(url: string): RecordedRequest[];
}

/**
 * Replaces the global fetch for the current test. Unknown URLs throw so that
 * accidental network access fails loudly. Undo with vi.unstubAllGlobals().
 */
export function mockFetch(routes: Record<string, Route>): FetchMock {
  const remaining = new Map(Object.entries(routes).map(([url, r]) => [url, Array.isArray(r) ? [...r] : r]));
  const calls: RecordedRequest[] = [];

  const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const req: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(req);
    const route = remaining.get(url);
    if (route === undefined) throw new Error(`mockFetch: unexpected request to ${url}`);
    const next = Array.isArray(route) ? route.shift() : route;
    if (next === undefined) throw new Error(`mockFetch: no replies left for ${url}`);
    return next(req, init.signal ?? undefined);
  };

  vi.stubGlobal("fetch", vi.fn(fake));
  return { calls, callsTo: (url) => calls.filter((c) => c.url === url) };
}
