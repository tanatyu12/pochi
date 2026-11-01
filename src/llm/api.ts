import * as z from "zod";
import { parseHttpUrl } from "../util/hash.js";
import { HttpError, parseRetryAfter, readText } from "../util/http.js";
import { log } from "../util/log.js";
import { sleep } from "../util/time.js";
import { VERSION } from "../version.js";
import {
  type GenerateRequest,
  type LlmClient,
  LlmError,
  type LlmTier,
  PROMPT_TOO_LONG,
  type StatusKind,
  statusKind,
  toJsonSchema,
  validateReply,
} from "./schema.js";

export const DEFAULT_API_MODELS: Record<LlmTier, string> = {
  triage: "claude-haiku-5-5",
  analyze: "claude-sonnet-5-5",
};

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
// Thinking stays at the models' default (adaptive); effort keeps triage cheap across many batches.
const EFFORT: Record<LlmTier, "low" | "medium"> = { triage: "low", analyze: "medium" };
// Models that reject effort with a 400: it arrived with Opus 4.5 and is on every model from 4.6 on,
// but Sonnet 4.5, Haiku 4.5 and older models do not take it. A configured model may be one of them.
const NO_EFFORT = /^claude-(3|haiku-4-5|sonnet-4-5|sonnet-4-0|sonnet-4-\d{8}|opus-4-0|opus-4-1|opus-4-\d{8})/;
// Includes thinking tokens. Small enough for a non-streaming reply to arrive well within the timeout.
const MAX_TOKENS = 16_000;
// Matches the claude CLI's limit, and covers the whole call, retries and their waits included.
const TIMEOUT_MS = 300_000;
// As the official SDKs do: two retries for 408, 409, 429, 5xx and connection errors.
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;
// A server asking for a longer wait will not be ready within this call's retries.
const MAX_RETRY_AFTER_MS = 60_000;
// A reply holds at most MAX_TOKENS of text; this only guards against a misbehaving gateway.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
// Looking a model up answers at once; a slower API is left to the first real call to judge.
const PREFLIGHT_TIMEOUT_MS = 10_000;

// Only the fields read below; the rest of the Message is ignored so additions to it change nothing.
const MessageSchema = z.object({
  id: z.string().optional(),
  stop_reason: z.string().nullish(),
  stop_details: z.object({ category: z.string().nullish() }).nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
type Message = z.infer<typeof MessageSchema>;

const ErrorBodySchema = z.object({ error: z.object({ type: z.string().optional(), message: z.string().optional() }) });

export interface ApiLlmOptions {
  models: Record<LlmTier, string>;
  /** Sent as x-api-key. The adapter passes the same trimmed key it chose the mode with. */
  apiKey?: string;
  /** Sent as a bearer token when there is no apiKey (ANTHROPIC_AUTH_TOKEN, for gateways). */
  authToken?: string;
  /** ANTHROPIC_BASE_URL; the public API when unset. */
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** The first backoff when the server gives no Retry-After; doubled per retry. */
  retryBaseMs?: number;
}

/**
 * Calls POST /v1/messages with fetch. The model names are already resolved (config over
 * DEFAULT_API_MODELS) by the adapter, and nothing here reads the environment.
 *
 * The reply's JSON Schema goes in output_config.format (the same one the CLI mode sends), and the
 * text is parsed and validated here only after stop_reason has been checked, so a refusal or a
 * reply cut off at max_tokens is reported as such rather than as invalid output.
 */
export function createApiLlm(opts: ApiLlmOptions): LlmClient {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const base = apiBase(opts.baseUrl);
  const url = `${base}/v1/messages`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": API_VERSION,
    "user-agent": `pochi/${VERSION}`,
  };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  else if (opts.authToken) headers.authorization = `Bearer ${opts.authToken}`;
  const retry = { max: opts.maxRetries ?? MAX_RETRIES, baseMs: opts.retryBaseMs ?? RETRY_BASE_MS };

  return {
    mode: "api",
    async generate<T>(req: GenerateRequest<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
      const model = opts.models[req.tier];
      if (!opts.apiKey && !opts.authToken) {
        throw new LlmError("auth", `No Anthropic credentials found; set ANTHROPIC_API_KEY (${model})`);
      }
      const format = { type: "json_schema" as const, schema: toJsonSchema(req.schema) };
      const body = JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: NO_EFFORT.test(model) ? { format } : { effort: EFFORT[req.tier], format },
      });
      const deadline = AbortSignal.timeout(timeoutMs);
      const call = { url, headers, body, model, retry, signal, deadline, endsAt: Date.now() + timeoutMs };
      let message: Message;
      try {
        message = await send(call);
      } catch (err) {
        // The caller cancelled: their reason, not an LlmError.
        if (signal?.aborted) throw signal.reason;
        if (err instanceof LlmError) throw err;
        if (deadline.aborted) throw new LlmError("timeout", `Anthropic API timed out (${model})`);
        throw err;
      }
      return parseReply(message, req, model);
    },
    async preflight({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
      if (!opts.apiKey && !opts.authToken) {
        throw new LlmError("auth", "No Anthropic credentials found; set ANTHROPIC_API_KEY");
      }
      const tiers = new Map<string, LlmTier[]>();
      for (const tier of ["triage", "analyze"] as const) {
        const model = opts.models[tier];
        tiers.set(model, [...(tiers.get(model) ?? []), tier]);
      }
      const gateway = Boolean(opts.baseUrl?.trim());
      await Promise.all(
        [...tiers].map(([model, of]) => checkModel({ base, headers, model, tiers: of, gateway, signal })),
      );
    },
  };
}

function apiBase(baseUrl: string | undefined): string {
  const base = baseUrl?.trim() || DEFAULT_BASE_URL;
  // The value is not quoted: a gateway URL may carry credentials.
  if (!parseHttpUrl(base)) throw new LlmError("unavailable", "ANTHROPIC_BASE_URL is not an http(s) URL");
  return base.replace(/\/+$/, "");
}

const CONFIG_FIELD: Record<LlmTier, string> = { triage: "llm.triageModel", analyze: "llm.analyzeModel" };

/**
 * GET /v1/models/{model}: costs no tokens, and fails the way every message would with a key that
 * was revoked (401/403) or a model name the API does not know (404). Anything else (a 5xx, a
 * timeout, no network) says nothing lasting, so it is left to the first call and its retries. A
 * gateway (ANTHROPIC_BASE_URL) need not serve this endpoint, so a 404 from one is not trusted.
 */
async function checkModel(check: {
  base: string;
  headers: Record<string, string>;
  model: string;
  tiers: LlmTier[];
  gateway: boolean;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const { model, signal } = check;
  const deadline = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
  const both = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const { "content-type": _, ...headers } = check.headers;
  let res: Response;
  try {
    res = await fetch(`${check.base}/v1/models/${encodeURIComponent(model)}`, { method: "GET", headers, signal: both });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    log.debug(`could not look up ${model} before the run; the first call will tell`, err);
    return;
  }
  // Only the status and the request id are used; the body is not needed.
  await res.body?.cancel().catch(() => {});
  const where = [`HTTP ${res.status}`, model, requestId(res)].filter(Boolean).join(", ");
  if (res.status === 401 || res.status === 403) throw new LlmError("auth", `${STATUS_MESSAGES.auth} (${where})`);
  if (res.status === 404 && !check.gateway) {
    const fields = check.tiers.map((t) => CONFIG_FIELD[t]).join(" and ");
    throw new LlmError("unavailable", `Anthropic API does not know the model; check ${fields} in context.yml (${where})`);
  }
  if (!res.ok) log.debug(`looking up ${model} before the run returned ${where}; the first call will tell`);
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
  model: string;
  retry: { max: number; baseMs: number };
  signal: AbortSignal | undefined;
  deadline: AbortSignal;
  endsAt: number;
}

/** A failed attempt, with what the retry decision needs. */
interface Failure {
  error: LlmError;
  retryable: boolean;
  retryAfterMs?: number;
}

async function send(call: Call): Promise<Message> {
  const signal = call.signal ? AbortSignal.any([call.deadline, call.signal]) : call.deadline;
  for (let attempt = 0; ; attempt++) {
    const outcome = await once(call, signal);
    if (!("error" in outcome)) return outcome.message;
    const { error, retryable, retryAfterMs } = outcome;
    if (!retryable || attempt >= call.retry.max) throw error;
    let delayMs: number;
    if (retryAfterMs !== undefined) {
      if (retryAfterMs > MAX_RETRY_AFTER_MS) throw error;
      delayMs = retryAfterMs;
    } else {
      delayMs = Math.min(call.retry.baseMs * 2 ** attempt, RETRY_MAX_MS) * (1 - Math.random() * 0.25);
    }
    // Waiting past the deadline would turn this error into a less informative timeout.
    if (Date.now() + delayMs >= call.endsAt) throw error;
    await sleep(delayMs, signal);
  }
}

async function once(call: Call, signal: AbortSignal): Promise<{ message: Message } | Failure> {
  let res: Response;
  try {
    res = await fetch(call.url, { method: "POST", headers: call.headers, body: call.body, signal });
  } catch (err) {
    if (signal.aborted) throw err;
    // The cause is fetch's own error (ENOTFOUND, a TLS error...), never a response body.
    return {
      error: new LlmError("transport", `Could not reach the Anthropic API (${call.model})`, { cause: err }),
      retryable: true,
    };
  }
  if (!res.ok) return statusFailure(res, call.model, signal);
  let text: string;
  try {
    text = await readText(res, MAX_RESPONSE_BYTES, "Anthropic API");
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof HttpError) {
      return { error: new LlmError("invalid_output", `Anthropic API reply is too large (${call.model})`), retryable: false };
    }
    return {
      error: new LlmError("transport", `Anthropic API connection failed mid-reply (${call.model})`, { cause: err }),
      retryable: true,
    };
  }
  const where = [call.model, requestId(res)].filter(Boolean).join(", ");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: new LlmError("invalid_output", `Anthropic API returned malformed JSON (${where})`), retryable: false };
  }
  const parsed = MessageSchema.safeParse(json);
  if (!parsed.success) {
    return { error: new LlmError("invalid_output", `Anthropic API returned an unexpected reply (${where})`), retryable: false };
  }
  return { message: parsed.data };
}

const STATUS_MESSAGES: Record<StatusKind, string> = {
  auth: "Anthropic API rejected ANTHROPIC_API_KEY",
  rate_limit: "Anthropic API rate limit reached",
  timeout: "Anthropic API timed out",
  transport: "Anthropic API is unavailable",
  unavailable: "Anthropic API rejected the request",
  too_large: "Anthropic API rejected the request as too large",
  bad_request: "Anthropic API rejected the request as invalid",
};

// The message is built from the status, the error type and the request id. The body's own text
// can echo request fields, so it is only matched, never quoted or kept as the cause.
async function statusFailure(res: Response, model: string, signal: AbortSignal): Promise<Failure> {
  let type: string | undefined;
  let detail = "";
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(await readText(res, MAX_ERROR_BYTES, "Anthropic API")));
    if (parsed.success) {
      type = parsed.data.error.type;
      detail = parsed.data.error.message ?? "";
    }
  } catch {
    if (signal.aborted) throw signal.reason;
    // An unreadable or non-JSON body: the status alone decides.
  }
  const where = [`HTTP ${res.status}${type ? ` ${type}` : ""}`, model, requestId(res)].filter(Boolean).join(", ");
  const kind = res.status === 400 && PROMPT_TOO_LONG.test(detail) ? "too_large" : statusKind(res.status);
  return {
    error: new LlmError(kind, `${STATUS_MESSAGES[kind]} (${where})`),
    retryable: shouldRetry(res),
    retryAfterMs: retryAfter(res.headers),
  };
}

function shouldRetry(res: Response): boolean {
  // The API says so itself where it can; the statuses are the fallback, as in the SDKs.
  const hint = res.headers.get("x-should-retry");
  if (hint === "true") return true;
  if (hint === "false") return false;
  return res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
}

function retryAfter(headers: Headers): number | undefined {
  const ms = Number.parseFloat(headers.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms) && ms >= 0) return ms;
  return parseRetryAfter(headers.get("retry-after"));
}

function requestId(res: Response): string | undefined {
  const id = res.headers.get("request-id")?.trim();
  return id ? `request ${id}` : undefined;
}

function parseReply<T>(message: Message, req: GenerateRequest<T>, model: string): T {
  const where = `${model}${message.id ? `, message ${message.id}` : ""}`;
  switch (message.stop_reason) {
    case "refusal": {
      const category = message.stop_details?.category;
      throw new LlmError("refusal", `Claude declined the request${category ? ` (${category})` : ""} (${where})`);
    }
    case "max_tokens":
    case "model_context_window_exceeded":
      throw new LlmError("max_tokens", `Claude's reply was cut off: ${message.stop_reason} (${where})`);
  }
  const blocks = message.content.filter((b) => b.type === "text");
  if (blocks.length === 0) throw new LlmError("invalid_output", `Claude returned no text (${where})`);
  let value: unknown;
  try {
    value = JSON.parse(blocks.map((b) => b.text ?? "").join(""));
  } catch {
    // The SyntaxError quotes the reply, so it is not kept as the cause.
    throw new LlmError("invalid_output", `Claude returned malformed JSON (${where})`);
  }
  return validateReply(value, req.schema, where);
}
