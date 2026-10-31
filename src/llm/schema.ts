import { z } from "zod";
import { ImpactSchema } from "../config/schema.js";
import { ExitCode, PochiError } from "../errors.js";

// No length or count limits: models break them now and then, and one overlong summary should
// not fail a whole batch. Business rules are checked in code (pipeline/filter, init), with the
// limits exported from prompts.ts.

export const TriageOutputSchema = z.object({
  decisions: z.array(z.object({ id: z.string(), relevant: z.boolean(), reason: z.string() })),
});
export type TriageOutput = z.output<typeof TriageOutputSchema>;

export const AnalysisOutputSchema = z.object({
  insights: z.array(
    z.object({ id: z.string(), title: z.string(), summary: z.string(), impact: ImpactSchema, action: z.string() }),
  ),
});
export type AnalysisOutput = z.output<typeof AnalysisOutputSchema>;

export const RepoInferenceOutputSchema = z.object({
  results: z.array(
    z.object({ id: z.string(), candidates: z.array(z.object({ repo: z.string(), note: z.string() })) }),
  ),
});
export type RepoInferenceOutput = z.output<typeof RepoInferenceOutputSchema>;

export const QuerySuggestionOutputSchema = z.object({ queries: z.array(z.string()) });
export type QuerySuggestionOutput = z.output<typeof QuerySuggestionOutputSchema>;

export const PerspectiveSchema = z.enum(["tech", "design", "marketing", "business", "ops"]);
export const IdeaSuggestionOutputSchema = z.object({
  ideas: z.array(
    z.object({
      perspective: PerspectiveSchema,
      problem: z.string(),
      why: z.string(),
      sites: z.array(z.string()),
      queries: z.array(z.string()),
    }),
  ),
});
export type IdeaSuggestionOutput = z.output<typeof IdeaSuggestionOutputSchema>;

/**
 * JSON Schema for the claude CLI's --json-schema and for the API when zodOutputFormat is not
 * usable. It describes the input side, since what the model emits is what we parse. Input mode
 * leaves objects open, so every object is closed here (additionalProperties: false), as
 * structured outputs require; $schema is dropped since neither consumer needs it.
 *
 * Cached per schema, since every batch sends the same one: callers must not modify the result.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  let cached = jsonSchemas.get(schema);
  if (!cached) {
    const { $schema: _, ...rest } = z.toJSONSchema(schema, {
      io: "input",
      override: ({ jsonSchema }) => {
        if (jsonSchema.type === "object") jsonSchema.additionalProperties = false;
      },
    });
    cached = rest;
    jsonSchemas.set(schema, cached);
  }
  return cached;
}

const jsonSchemas = new WeakMap<z.ZodType, Record<string, unknown>>();

/** Where a reply failed the schema, without the values (they carry fetched text). */
export function issuePaths(error: z.ZodError): string {
  return [...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].slice(0, 5).join(", ");
}

/** The parsed reply, or invalid_output naming only the failing paths. where goes in the message. */
export function validateReply<T>(value: unknown, schema: z.ZodType<T>, where: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const paths = issuePaths(parsed.error);
    throw new LlmError("invalid_output", `Claude's reply did not match the schema at ${paths} (${where})`);
  }
  return parsed.data;
}

export type StatusKind = Extract<
  LlmErrorKind,
  "auth" | "rate_limit" | "timeout" | "transport" | "unavailable" | "too_large" | "bad_request"
>;

/**
 * The error text for an input over the context window, from the API (a 400 body) and from claude
 * (its result, with or without a status). Only matched, never quoted: it is the response body.
 */
export const PROMPT_TOO_LONG = /prompt is too long/i;

/** The kind for an HTTP status from the Anthropic API, in both modes. */
export function statusKind(status: number | undefined): StatusKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  // The request was too large; smaller batches get through.
  if (status === 413) return "too_large";
  // 408 / 409 and 5xx are transient: the SDK and claude have already retried them.
  if (status === 408) return "timeout";
  if (status === 409 || (status !== undefined && status >= 500)) return "transport";
  // A 400 can come from one item's content, so the batch is split; a configuration error shows up
  // as every part failing, which stops the run then.
  if (status === 400) return "bad_request";
  // 404 and the rest: usually a model name that is not known, which retrying will not fix.
  return "unavailable";
}

export type LlmTier = "triage" | "analyze";

export interface GenerateRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  tier: LlmTier;
}

export interface LlmClient {
  readonly mode: "api" | "cli";
  generate<T>(req: GenerateRequest<T>, opts?: { signal?: AbortSignal }): Promise<T>;
}

export type LlmErrorKind =
  | "unavailable"
  | "auth"
  | "rate_limit"
  | "transport"
  | "timeout"
  | "refusal"
  | "max_tokens"
  | "too_large"
  | "bad_request"
  | "invalid_output";

/** Messages never include the prompt or the model's output, since both carry fetched text. */
export class LlmError extends PochiError {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.LLM, options);
    this.kind = kind;
  }
}
