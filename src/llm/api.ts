import Anthropic from "@anthropic-ai/sdk";
import {
  type GenerateRequest,
  issuePaths,
  type LlmClient,
  LlmError,
  type LlmTier,
  toJsonSchema,
} from "./schema.js";

export const DEFAULT_API_MODELS: Record<LlmTier, string> = {
  triage: "claude-haiku-5-5",
  analyze: "claude-sonnet-5-5",
};

// Thinking stays at the models' default (adaptive); effort keeps triage cheap across many batches.
const EFFORT: Record<LlmTier, "low" | "medium"> = { triage: "low", analyze: "medium" };
// Includes thinking tokens. The largest non-streaming value that stays clear of the SDK's timeouts.
const MAX_TOKENS = 16_000;
// Matches the claude CLI's limit. The SDK still retries 408/409/429/5xx and connection errors twice.
const TIMEOUT_MS = 300_000;

/**
 * The model names are already resolved (config over DEFAULT_API_MODELS) by the adapter.
 *
 * Uses messages.create rather than messages.parse with zodOutputFormat: parse validates every
 * text block inside the SDK call and throws a generic error before stop_reason can be read, so a
 * refusal or a reply cut off at max_tokens would look like invalid output. The schema is the same
 * one the CLI mode sends.
 */
export function createApiLlm(opts: { models: Record<LlmTier, string>; client?: Anthropic }): LlmClient {
  const client = opts.client ?? new Anthropic({ timeout: TIMEOUT_MS });
  return {
    mode: "api",
    async generate<T>(req: GenerateRequest<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
      const model = opts.models[req.tier];
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS,
            system: req.system,
            messages: [{ role: "user", content: req.prompt }],
            output_config: {
              effort: EFFORT[req.tier],
              format: { type: "json_schema", schema: toJsonSchema(req.schema) },
            },
          },
          { signal },
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
  const text = message.content.find((b) => b.type === "text")?.text;
  if (text === undefined) throw new LlmError("invalid_output", `Claude returned no text (${where})`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The SyntaxError quotes the reply, so it is not kept as the cause.
    throw new LlmError("invalid_output", `Claude returned malformed JSON (${where})`);
  }
  const parsed = req.schema.safeParse(value);
  if (!parsed.success) {
    const paths = issuePaths(parsed.error);
    throw new LlmError("invalid_output", `Claude's reply did not match the schema at ${paths} (${where})`);
  }
  return parsed.data;
}

// Messages are built here rather than taken from the SDK, whose API error text can echo request fields.
function toLlmError(err: unknown, model: string, signal: AbortSignal | undefined): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return signal?.aborted ? signal.reason : err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError("timeout", `Anthropic API timed out (${model})`, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError("transport", `Could not reach the Anthropic API (${model})`, { cause: err });
  }
  if (!(err instanceof Anthropic.APIError)) return err;
  const where = `HTTP ${err.status}, ${model}${err.requestID ? `, request ${err.requestID}` : ""}`;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError("auth", `Anthropic API rejected ANTHROPIC_API_KEY (${where})`, { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError("rate_limit", `Anthropic API rate limit reached (${where})`, { cause: err });
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new LlmError("transport", `Anthropic API is unavailable (${where})`, { cause: err });
  }
  // 400 / 404 and the rest: usually a model name the API does not know, which retrying will not fix.
  return new LlmError("unavailable", `Anthropic API rejected the request (${where})`, { cause: err });
}
