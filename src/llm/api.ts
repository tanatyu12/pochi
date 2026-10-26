import Anthropic from "@anthropic-ai/sdk";
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

// Thinking stays at the models' default (adaptive); effort keeps triage cheap across many batches.
const EFFORT: Record<LlmTier, "low" | "medium"> = { triage: "low", analyze: "medium" };
// Models that reject effort with a 400: it arrived with Opus 4.5 and is on every model from 4.6 on,
// but Sonnet 4.5, Haiku 4.5 and older models do not take it. A configured model may be one of them.
const NO_EFFORT = /^claude-(3|haiku-4-5|sonnet-4-5|sonnet-4-0|sonnet-4-\d{8}|opus-4-0|opus-4-1|opus-4-\d{8})/;
// Includes thinking tokens. The largest non-streaming value that stays clear of the SDK's timeouts.
const MAX_TOKENS = 16_000;
// Matches the claude CLI's limit. The SDK retries 408/409/429/5xx and connection errors twice, and
// timeouts too, so the limit covers the whole call rather than each attempt.
const TIMEOUT_MS = 300_000;

/**
 * The model names are already resolved (config over DEFAULT_API_MODELS) by the adapter.
 *
 * Uses messages.create rather than messages.parse with zodOutputFormat: parse validates every
 * text block inside the SDK call and throws a generic error before stop_reason can be read, so a
 * refusal or a reply cut off at max_tokens would look like invalid output. The schema is the same
 * one the CLI mode sends.
 */
export function createApiLlm(opts: {
  models: Record<LlmTier, string>;
  /** The key the adapter chose the mode with; without one, the SDK reads ANTHROPIC_API_KEY itself. */
  apiKey?: string;
  client?: Anthropic;
  timeoutMs?: number;
}): LlmClient {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: timeoutMs });
  return {
    mode: "api",
    async generate<T>(req: GenerateRequest<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
      const model = opts.models[req.tier];
      const format = { type: "json_schema" as const, schema: toJsonSchema(req.schema) };
      const deadline = AbortSignal.timeout(timeoutMs);
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS,
            system: req.system,
            messages: [{ role: "user", content: req.prompt }],
            output_config: NO_EFFORT.test(model) ? { format } : { effort: EFFORT[req.tier], format },
          },
          { signal: signal ? AbortSignal.any([deadline, signal]) : deadline },
        );
      } catch (err) {
        throw toLlmError(err, model, signal);
      }
      return parseReply(message, req, model);
    },
  };
}

function parseReply<T>(message: Anthropic.Message, req: GenerateRequest<T>, model: string): T {
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
    value = JSON.parse(blocks.map((b) => b.text).join(""));
  } catch {
    // The SyntaxError quotes the reply, so it is not kept as the cause.
    throw new LlmError("invalid_output", `Claude returned malformed JSON (${where})`);
  }
  return validateReply(value, req.schema, where);
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

// Messages are built here rather than taken from the SDK. Its API error text carries the response
// body, which can echo request fields, so API errors are not kept as the cause either (the CLI
// prints the cause). Connection errors are kept: their cause is the fetch error, not a body.
function toLlmError(err: unknown, model: string, signal: AbortSignal | undefined): unknown {
  if (err instanceof Anthropic.APIUserAbortError) {
    if (signal?.aborted) return signal.reason;
    return new LlmError("timeout", `Anthropic API timed out (${model})`);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError("timeout", `Anthropic API timed out (${model})`, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError("transport", `Could not reach the Anthropic API (${model})`, { cause: err });
  }
  if (!(err instanceof Anthropic.APIError)) {
    // Thrown before any request is sent: no key found, or a request the SDK will not send as is.
    if (err instanceof Error && err.message.startsWith("Could not resolve authentication method")) {
      return new LlmError("auth", `No Anthropic credentials found; set ANTHROPIC_API_KEY (${model})`);
    }
    if (err instanceof Anthropic.AnthropicError) {
      return new LlmError("unavailable", `Anthropic SDK rejected the request (${model})`);
    }
    return err;
  }
  const status = [err.status && `HTTP ${err.status}`, err.type].filter(Boolean).join(" ");
  const where = [status, model, err.requestID && `request ${err.requestID}`].filter(Boolean).join(", ");
  const kind = err.status === 400 && PROMPT_TOO_LONG.test(err.message) ? "too_large" : statusKind(err.status);
  return new LlmError(kind, `${STATUS_MESSAGES[kind]} (${where})`);
}
