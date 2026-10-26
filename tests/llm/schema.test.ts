import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExitCode, exitCodeOf, PochiError } from "../../src/errors.js";
import {
  AnalysisOutputSchema,
  LlmError,
  QuerySuggestionOutputSchema,
  RepoInferenceOutputSchema,
  toJsonSchema,
  TriageOutputSchema,
} from "../../src/llm/schema.js";

const schemas = {
  TriageOutput: TriageOutputSchema,
  AnalysisOutput: AnalysisOutputSchema,
  RepoInferenceOutput: RepoInferenceOutputSchema,
  QuerySuggestionOutput: QuerySuggestionOutputSchema,
};

// Every object node in a JSON Schema, wherever it sits.
function objectNodes(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(objectNodes);
  if (node === null || typeof node !== "object") return [];
  const children = Object.values(node).flatMap(objectNodes);
  return (node as { type?: unknown }).type === "object" ? [node as Record<string, unknown>, ...children] : children;
}

describe("toJsonSchema", () => {
  it.each(Object.entries(schemas))("matches the snapshot for %s", (name, schema) => {
    expect(toJsonSchema(schema)).toMatchSnapshot(name);
  });

  // Structured outputs need every key required. A .default() makes its key optional on the
  // input side, so this fails if one is added to an output schema.
  it.each(Object.entries(schemas))("closes every object and requires every key in %s", (_, schema) => {
    const json = toJsonSchema(schema);
    expect(json).not.toHaveProperty("$schema");
    const objects = objectNodes(json);
    expect(objects.length).toBeGreaterThan(0);
    for (const obj of objects) {
      expect(obj.additionalProperties).toBe(false);
      expect(obj.required).toEqual(Object.keys(obj.properties as object));
    }
  });

  it("describes what the model sends, not what parsing returns", () => {
    const schema = z.object({ a: z.string(), b: z.string().default("x"), c: z.string().transform(Number) });
    expect(toJsonSchema(schema)).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string", default: "x" }, c: { type: "string" } },
      required: ["a", "c"],
      additionalProperties: false,
    });
  });

  it("builds each schema once", () => {
    expect(toJsonSchema(TriageOutputSchema)).toBe(toJsonSchema(TriageOutputSchema));
  });
});

describe("output schemas", () => {
  it("parses well-formed output", () => {
    const insight = { id: "i1", title: "t", summary: "s", impact: "High", action: "a" };
    expect(AnalysisOutputSchema.parse({ insights: [insight] })).toEqual({ insights: [insight] });
    expect(TriageOutputSchema.parse({ decisions: [{ id: "i1", relevant: false, reason: "r" }] }).decisions).toHaveLength(1);
    expect(RepoInferenceOutputSchema.parse({ results: [{ id: "q1", candidates: [] }] }).results).toHaveLength(1);
    expect(QuerySuggestionOutputSchema.parse({ queries: ["q"] })).toEqual({ queries: ["q"] });
  });

  it("rejects an unknown impact and missing keys", () => {
    const insight = { id: "i1", title: "t", summary: "s", impact: "Critical", action: "a" };
    expect(AnalysisOutputSchema.safeParse({ insights: [insight] }).success).toBe(false);
    expect(TriageOutputSchema.safeParse({ decisions: [{ id: "i1", relevant: true }] }).success).toBe(false);
  });
});

describe("LlmError", () => {
  it("carries its kind and maps to exit code 3", () => {
    const err = new LlmError("refusal", "the model refused");
    expect(err).toBeInstanceOf(PochiError);
    expect(err.name).toBe("LlmError");
    expect(err.kind).toBe("refusal");
    expect(err.exitCode).toBe(ExitCode.LLM);
    expect(exitCodeOf(err)).toBe(3);
  });
});
