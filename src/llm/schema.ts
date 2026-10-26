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
  | "invalid_output";

/** Messages never include the prompt or the model's output, since both carry fetched text. */
export class LlmError extends PochiError {
  readonly kind: LlmErrorKind;

  constructor(kind: LlmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.LLM, options);
    this.kind = kind;
  }
}
