import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextSchema } from "../../src/config/schema.js";
import { ExitCode, exitCodeOf } from "../../src/errors.js";
import { buildCliArgs, createCliLlm, DEFAULT_CLI_MODELS, findFirstJsonObject, type SpawnFn } from "../../src/llm/cli.js";
import { triageRequest } from "../../src/llm/prompts.js";
import {
  type GenerateRequest,
  LlmError,
  type LlmErrorKind,
  toJsonSchema,
  TriageOutputSchema,
  type TriageOutput,
} from "../../src/llm/schema.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { fakeSpawn, run } from "../helpers/fakeSpawn.js";

// Planted in the prompt, the system prompt and claude's output; no error message may carry it.
const SECRET = "PLANTED-7f3a";

const request: GenerateRequest<TriageOutput> = {
  system: `system prompt ${SECRET}`,
  prompt: `items ${SECRET}`,
  schema: TriageOutputSchema,
  tier: "triage",
};

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/claude/${name}`, import.meta.url), "utf8"));
const structured = fixture("structured.json");

function envelope(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...structured, ...overrides });
}

function llm(spawn: SpawnFn, opts: { timeoutMs?: number; maxBytes?: number } = {}) {
  return createCliLlm({ models: DEFAULT_CLI_MODELS, spawn, ...opts });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable("expected a rejection"),
    (err: unknown) => err,
  );
}

async function expectLlmError(promise: Promise<unknown>, kind: LlmErrorKind): Promise<LlmError> {
  const err = await failure(promise);
  expect(err).toBeInstanceOf(LlmError);
  const e = err as LlmError;
  expect(e.kind).toBe(kind);
  expect(exitCodeOf(e)).toBe(ExitCode.LLM);
  expect(e.message).not.toContain(SECRET);
  return e;
}

afterEach(() => {
  vi.useRealTimers();
  resetLog();
});

describe("buildCliArgs", () => {
  const context = ContextSchema.parse({
    version: 1,
    project: { name: "my-app", description: "A Next.js SaaS app" },
    problems: ["Breaking changes in Next.js"],
    language: "English",
  });
  const req = triageRequest(context, [
    {
      id: "id1",
      urlKey: "key1",
      sourceId: "blog",
      sourceName: "Blog",
      kind: "rss",
      title: "Next.js 16.1",
      url: "https://example.com/1",
      content: `Content ${SECRET}`,
    },
  ]);

  it("builds the arguments in this exact order", () => {
    expect(buildCliArgs(req, "haiku")).toMatchSnapshot();
  });

  it("disables tools and MCP servers and keeps the prompt out of argv", () => {
    const args = buildCliArgs(req, "haiku");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual(toJsonSchema(TriageOutputSchema));
    expect(args.join("\n")).not.toContain(SECRET);
  });
});

describe("createCliLlm", () => {
  it("returns structured_output, validated", async () => {
    const { spawn } = fakeSpawn(run.fixture("structured.json"));
    const client = llm(spawn);
    expect(client.mode).toBe("cli");
    await expect(client.generate(request)).resolves.toEqual(structured.structured_output);
  });

  it("passes the prompt on stdin and runs claude without a shell in the temp directory", async () => {
    const { spawn, calls } = fakeSpawn(run.fixture("structured.json"));
    await llm(spawn).generate(request);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("claude");
    expect(call.stdin).toBe(request.prompt);
    expect(call.options).toMatchObject({ cwd: tmpdir(), shell: false });
    expect(call.args).toEqual(buildCliArgs(request, "haiku"));
    expect(call.args).not.toContain(request.prompt);
  });

  it.each([
    ["triage", "haiku"],
    ["analyze", "sonnet"],
  ] as const)("uses the %s tier's model", async (tier, model) => {
    const { spawn, calls } = fakeSpawn(run.fixture("structured.json"));
    await llm(spawn).generate({ ...request, tier });
    const args = calls[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe(model);
  });

  it("uses the resolved model names and command it was given", async () => {
    const { spawn, calls } = fakeSpawn(run.fixture("structured.json"));
    await createCliLlm({ models: { triage: "my-triage", analyze: "my-analyze" }, spawn, command: "/opt/claude" })
      .generate(request);
    expect(calls[0]!.command).toBe("/opt/claude");
    expect(calls[0]!.args).toContain("my-triage");
  });

  it("falls back to the first JSON object in result, ignoring ANSI codes and prose", async () => {
    const { spawn } = fakeSpawn(run.fixture("result-only.json"));
    await expect(llm(spawn).generate(request)).resolves.toEqual(structured.structured_output);
  });

  it("rejects structured_output that does not match the schema, naming only the path", async () => {
    const output = { decisions: [{ id: "i1", relevant: SECRET, reason: SECRET }] };
    const { spawn } = fakeSpawn(run.exit(envelope({ structured_output: output })));
    const err = await expectLlmError(llm(spawn).generate(request), "invalid_output");
    expect(err.message).toContain("decisions.0.relevant");
  });

  it("rejects a fallback object that does not match the schema", async () => {
    const result = `Sure! {"answer": "${SECRET}"}`;
    const { spawn } = fakeSpawn(run.exit(envelope({ structured_output: undefined, result })));
    await expectLlmError(llm(spawn).generate(request), "invalid_output");
  });

  it("reports invalid output when result holds no JSON object", async () => {
    const { spawn } = fakeSpawn(run.exit(envelope({ structured_output: undefined, result: `no json ${SECRET}` })));
    await expectLlmError(llm(spawn).generate(request), "invalid_output");
  });

  it.each([
    ["error-auth.json", 1, "auth", "HTTP 401"],
    ["error-rate-limit.json", 1, "rate_limit", "HTTP 429"],
    ["error-overloaded.json", 1, "transport", "HTTP 529"],
    ["error-model.json", 1, "unavailable", "HTTP 404"],
    ["error-structured-retries.json", 1, "invalid_output", "schema"],
    ["max-tokens.json", 0, "max_tokens", "max_tokens"],
    ["refusal.json", 0, "refusal", "declined"],
  ] as const)("turns %s into %s", async (name, code, kind, text) => {
    const { spawn } = fakeSpawn(run.fixture(name, { code }));
    const err = await expectLlmError(llm(spawn).generate(request), kind);
    expect(err.message).toContain(text);
    expect(err.message).toContain("haiku");
  });

  it("keeps claude's own error text out of the message", async () => {
    const { spawn } = fakeSpawn(run.exit(envelope({ is_error: true, api_error_status: 400, result: SECRET }), { code: 1 }));
    await expectLlmError(llm(spawn).generate(request), "unavailable");
  });

  it("reports a failed run with unreadable output as a transport error, logging stderr only in debug", async () => {
    const lines: string[] = [];
    configureLog({ level: "verbose", write: (s) => lines.push(s) });
    const { spawn } = fakeSpawn(run.fixture("not-json.txt", { code: 1, stderr: "boom" }));
    const err = await expectLlmError(llm(spawn).generate(request), "transport");
    expect(err.message).toContain("code 1");
    expect(lines.join("")).toContain("pochi: debug: claude stderr: boom");
  });

  it("reports a clean exit with unreadable output as invalid output", async () => {
    const { spawn } = fakeSpawn(run.exit(`not json ${SECRET}`));
    await expectLlmError(llm(spawn).generate(request), "invalid_output");
  });

  it("reports a missing claude command as unavailable", async () => {
    const { spawn } = fakeSpawn(run.spawnError("ENOENT"));
    const err = await expectLlmError(llm(spawn).generate(request), "unavailable");
    expect(err.message).toContain("claude command not found");
  });

  it("reports other spawn failures as transport errors", async () => {
    const { spawn } = fakeSpawn(run.spawnError("EACCES"));
    const err = await expectLlmError(llm(spawn).generate(request), "transport");
    expect(err.message).toContain("EACCES");
  });

  it("stops claude with SIGINT at the timeout", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawn(run.hang());
    const pending = failure(llm(spawn).generate(request));
    await vi.advanceTimersByTimeAsync(299_999);
    expect(calls[0]!.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe("timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls[0]!.signals).toEqual(["SIGINT"]);
  });

  it("kills claude with SIGKILL when it ignores SIGINT", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawn(run.hang({ ignoreSigint: true }));
    let settled = false;
    const pending = failure(llm(spawn, { timeoutMs: 1_000 }).generate(request)).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls[0]!.signals).toEqual(["SIGINT"]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0]!.signals).toEqual(["SIGINT", "SIGKILL"]);
    expect((await pending as LlmError).kind).toBe("timeout");
  });

  it("stops claude once its output passes the byte limit", async () => {
    const { spawn, calls } = fakeSpawn(run.chunks(["x".repeat(600), "x".repeat(600)]));
    const err = await expectLlmError(llm(spawn, { maxBytes: 1_000 }).generate(request), "invalid_output");
    expect(err.message).toContain("1000 bytes");
    expect(calls[0]!.signals).toEqual(["SIGINT"]);
  });

  it("accepts output exactly at the byte limit", async () => {
    const text = JSON.stringify(structured);
    const { spawn } = fakeSpawn(run.chunks([text.slice(0, 100), text.slice(100)]));
    await expect(llm(spawn, { maxBytes: Buffer.byteLength(text) }).generate(request)).resolves.toEqual(
      structured.structured_output,
    );
  });

  it("stops claude and rethrows the reason when the caller aborts", async () => {
    const { spawn, calls } = fakeSpawn(run.hang());
    const controller = new AbortController();
    const pending = failure(llm(spawn).generate(request, { signal: controller.signal }));
    const reason = new Error("cancelled");
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(calls[0]!.signals).toEqual(["SIGINT"]);
  });

  it("does not start claude when already aborted", async () => {
    const { spawn, calls } = fakeSpawn([]);
    const reason = new Error("cancelled");
    expect(await failure(llm(spawn).generate(request, { signal: AbortSignal.abort(reason) }))).toBe(reason);
    expect(calls).toHaveLength(0);
  });
});

describe("findFirstJsonObject", () => {
  it.each([
    ["a bare object", '{"a":1}', { a: 1 }],
    ["an object after prose", 'Here you go: {"a":1} done', { a: 1 }],
    ["braces inside strings", '{"a":"}{","b":"x"}', { a: "}{", b: "x" }],
    ["escaped quotes", '{"a":"say \\"}\\" now"}', { a: 'say "}" now' }],
    ["nested objects", '{"a":{"b":{"c":[1,{"d":2}]}}}', { a: { b: { c: [1, { d: 2 }] } } }],
    ["prose braces before the JSON", 'use {name} here: {"a":1}', { a: 1 }],
    ["the first of two objects", '{"a":1} {"b":2}', { a: 1 }],
  ])("finds %s", (_label, text, expected) => {
    expect(findFirstJsonObject(text)).toEqual(expected);
  });

  it.each([
    ["no braces", "no json here"],
    ["an unterminated object", '{"decisions":[{"id":"i1"'],
    ["only arrays", "[1, 2]"],
    ["an empty string", ""],
  ])("returns undefined for %s", (_label, text) => {
    expect(findFirstJsonObject(text)).toBeUndefined();
  });
});
