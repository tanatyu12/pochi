import { TextDecoder } from "node:util";
import { VERSION } from "../version.js";
import { redact } from "./log.js";
import { sleep } from "./time.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const RETRY_DELAY_MS = 1_000;
const USER_AGENT = `pochi/${VERSION}`;

export interface HttpOptions {
  headers?: Record<string, string>;
  /** Per attempt, including reading the body. */
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  retry?: {
    /** Retries for 5xx, network errors and timeouts. */
    server?: number;
    /** Retries for 429. */
    rateLimit?: number;
    maxRetryAfterMs?: number;
  };
}

export interface HttpResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  headers: Headers;
  text: string;
}

export type HttpErrorKind = "status" | "timeout" | "network" | "too_large" | "invalid_url";

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  /** Redacted, so it is safe to log. */
  readonly url: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: HttpErrorKind,
    url: string,
    message: string,
    options?: { status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "HttpError";
    this.kind = kind;
    this.url = url;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export function fetchText(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  return request(url, { method: "GET" }, opts);
}

export function postJson(url: string, body: unknown, opts: HttpOptions = {}): Promise<HttpResponse> {
  return request(
    url,
    { method: "POST", body: JSON.stringify(body), contentType: "application/json" },
    opts,
  );
}

interface RequestInit {
  method: string;
  body?: string;
  contentType?: string;
}

async function request(url: string, init: RequestInit, opts: HttpOptions): Promise<HttpResponse> {
  const safeUrl = redact(url);
  if (!isHttpUrl(url)) {
    throw new HttpError("invalid_url", safeUrl, `only http(s) URLs are allowed: ${safeUrl}`);
  }
  let serverRetries = opts.retry?.server ?? 1;
  let rateLimitRetries = opts.retry?.rateLimit ?? 1;
  const maxRetryAfterMs = opts.retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

  for (;;) {
    try {
      return await attempt(url, safeUrl, init, opts);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      let delayMs: number;
      if (err.status === 429 && rateLimitRetries > 0) {
        rateLimitRetries--;
        delayMs = Math.min(err.retryAfterMs ?? RETRY_DELAY_MS, maxRetryAfterMs);
      } else if (isServerSide(err) && serverRetries > 0) {
        serverRetries--;
        delayMs = RETRY_DELAY_MS;
      } else {
        throw err;
      }
      await sleep(delayMs, opts.signal);
    }
  }
}

async function attempt(
  url: string,
  safeUrl: string,
  init: RequestInit,
  opts: HttpOptions,
): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const headers = new Headers({ "user-agent": USER_AGENT });
  if (init.contentType) headers.set("content-type", init.contentType);
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);

  try {
    const res = await fetch(url, { method: init.method, headers, body: init.body, signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError("status", safeUrl, `HTTP ${res.status} for ${safeUrl}`, {
        status: res.status,
        retryAfterMs: res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined,
      });
    }
    const text = await readText(res, opts.maxBytes ?? DEFAULT_MAX_BYTES, safeUrl);
    return { url: res.url || url, status: res.status, headers: res.headers, text };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // The caller cancelled: pass their reason through untouched and do not retry.
    if (opts.signal?.aborted) throw err;
    if (timeout.aborted) {
      throw new HttpError("timeout", safeUrl, `timed out after ${timeoutMs}ms: ${safeUrl}`, { cause: err });
    }
    throw new HttpError("network", safeUrl, `request failed: ${safeUrl}`, { cause: err });
  }
}

async function readText(res: Response, maxBytes: number, safeUrl: string): Promise<string> {
  const tooLarge = () =>
    new HttpError("too_large", safeUrl, `response exceeds ${maxBytes} bytes: ${safeUrl}`);
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const text = decoderFor(res.headers.get("content-type")).decode(Buffer.concat(chunks));
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Honour the declared charset (e.g. Shift_JIS blogs); fall back to UTF-8 for unknown labels.
function decoderFor(contentType: string | null): TextDecoder {
  const charset = contentType?.match(/charset\s*=\s*"?([\w.:-]+)"?/i)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // Unknown label.
    }
  }
  return new TextDecoder("utf-8");
}

/** Retry-After is either delay-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function isServerSide(err: HttpError): boolean {
  return err.kind === "network" || err.kind === "timeout" || (err.status ?? 0) >= 500;
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
