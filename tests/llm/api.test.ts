import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExitCode, exitCodeOf } from "../../src/errors.js";
import { createApiLlm, DEFAULT_API_MODELS } from "../../src/llm/api.js";
import {
  type GenerateRequest,
  LlmError,
  type LlmErrorKind,
  TriageOutputSchema,
  type TriageOutput,
} from "../../src/llm/schema.js";
import { mockFetch, type Reply, reply } from "../helpers/mockFetch.js";

const URL = "https://api.anthropic.com/v1/messages";
// Planted in the prompt and the reply; no error message may carry it.
const SECRET = "PLANTED-7f3a";

const request: GenerateRequest<TriageOutput> = {
  system: "system prompt",
  prompt: `items ${SECRET}`,
  schema: TriageOutputSchema,
  tier: "triage",
};

function fakeClient(opts: { timeout?: number; maxRetries?: number } = {}): Anthropic {
  // The SDK resolves fetch when it sends, so the stub installed by mockFetch is the one called.
  return new Anthropic({ apiKey: "sk-ant-test", maxRetries: 0, fetch: (...args) => fetch(...args), ...opts });
}

function llm(client = fakeClient()) {
  return createApiLlm({ models: DEFAULT_API_MODELS, client });
}

function message(text: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: text === null ? [] : [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...overrides,
  };
}

const ok = { decisions: [{ id: "i1", relevant: true, reason: "matches" }] };

function apiError(status: number, type: string): Reply {
  return reply.json(
    { type: "error", error: { type, message: `echo of the request: ${SECRET}` } },
    { status, headers: { "request-id": "req_123" } },
  );
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
  // The CLI prints the cause's message too.
  expect(String(e.cause instanceof Error ? e.cause.message : e.cause)).not.toContain(SECRET);
  return e;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createApiLlm", () => {
  it("returns the validated output", async () => {
    mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    const client = llm();
    expect(client.mode).toBe("api");
    await expect(client.generate(request)).resolves.toEqual(ok);
  });

  it.each([
    ["triage", "claude-haiku-5-5", "low"],
    ["analyze", "claude-sonnet-5-5", "medium"],
  ] as const)("sends the %s tier with its model and effort, and nothing else", async (tier, model, effort) => {
    const fetchMock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await llm().generate({ ...request, tier });
    const body = JSON.parse(fetchMock.callsTo(URL)[0]!.body!);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(body).toMatchObject({
      model,
      system: "system prompt",
      messages: [{ role: "user", content: `items ${SECRET}` }],
      output_config: { effort, format: { type: "json_schema" } },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("thinking");
  });

  it("sends the request body in this exact shape", async () => {
    const fetchMock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await llm().generate(request);
    expect(JSON.parse(fetchMock.callsTo(URL)[0]!.body!)).toMatchSnapshot();
  });

  it("uses the resolved model names it was given", async () => {
    const fetchMock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await createApiLlm({ models: { triage: "my-triage", analyze: "my-analyze" }, client: fakeClient() }).generate(
      request,
    );
    expect(JSON.parse(fetchMock.callsTo(URL)[0]!.body!).model).toBe("my-triage");
  });

  it.each([
    ["claude-haiku-4-5", false],
    ["claude-sonnet-4-5-20250929", false],
    ["claude-3-5-haiku-latest", false],
    ["claude-opus-4-1", false],
    ["claude-opus-4-5", true],
    ["claude-sonnet-4-6", true],
    ["claude-haiku-5-5", true],
  ])("sends effort to %s: %s", async (model, sent) => {
    const fetchMock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await createApiLlm({ models: { triage: model, analyze: model }, client: fakeClient() }).generate(request);
    const config = JSON.parse(fetchMock.callsTo(URL)[0]!.body!).output_config;
    expect(config).toHaveProperty("format");
    expect("effort" in config).toBe(sent);
  });

  it("joins the reply's text blocks before parsing", async () => {
    const [head, tail] = [JSON.stringify(ok).slice(0, 10), JSON.stringify(ok).slice(10)];
    const content = [
      { type: "text", text: head },
      { type: "text", text: tail },
    ];
    mockFetch({ [URL]: reply.json(message(null, { content })) });
    await expect(llm().generate(request)).resolves.toEqual(ok);
  });

  it("turns a refusal into a refusal error with its category", async () => {
    mockFetch({
      [URL]: reply.json(
        message(SECRET, {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: SECRET },
        }),
      ),
    });
    const err = await expectLlmError(llm().generate(request), "refusal");
    expect(err.message).toContain("cyber");
  });

  it.each(["max_tokens", "model_context_window_exceeded"])("turns %s into a max_tokens error", async (stop_reason) => {
    mockFetch({ [URL]: reply.json(message(`{"decisions": [{"id": "${SECRET}`, { stop_reason })) });
    await expectLlmError(llm().generate(request), "max_tokens");
  });

  it.each([
    ["no text block", message(null)],
    ["malformed JSON", message(`not json ${SECRET}`)],
    ["JSON null", message("null")],
    ["a schema mismatch", message(JSON.stringify({ decisions: [{ id: SECRET, relevant: "yes" }] }))],
  ])("turns %s into invalid_output", async (_name, body) => {
    mockFetch({ [URL]: reply.json(body) });
    await expectLlmError(llm().generate(request), "invalid_output");
  });

  it("names the failing schema paths without their values", async () => {
    mockFetch({
      [URL]: reply.json(message(JSON.stringify({ decisions: [{ id: "i1", relevant: SECRET, reason: "r" }] }))),
    });
    const err = await expectLlmError(llm().generate(request), "invalid_output");
    expect(err.message).toContain("decisions.0.relevant");
  });

  it.each([
    [401, "authentication_error", "auth"],
    [403, "permission_error", "auth"],
    [429, "rate_limit_error", "rate_limit"],
    [500, "api_error", "transport"],
    [529, "overloaded_error", "transport"],
    [408, "timeout_error", "timeout"],
    [409, "conflict_error", "transport"],
    [400, "invalid_request_error", "unavailable"],
    [404, "not_found_error", "unavailable"],
  ] as const)("turns HTTP %i into %s", async (status, type, kind) => {
    mockFetch({ [URL]: apiError(status, type) });
    const err = await expectLlmError(llm().generate(request), kind as LlmErrorKind);
    expect(err.message).toContain(`HTTP ${status}`);
    expect(err.message).toContain(`HTTP ${status} ${type}`);
    expect(err.message).toContain("req_123");
    expect(err.cause).toBeUndefined();
  });

  it("turns a network error into transport", async () => {
    mockFetch({ [URL]: reply.networkError() });
    await expectLlmError(llm().generate(request), "transport");
  });

  it("turns a timeout into timeout", async () => {
    mockFetch({ [URL]: reply.hang() });
    await expectLlmError(llm(fakeClient({ timeout: 20 })).generate(request), "timeout");
  });

  it("bounds the whole call, retries included", async () => {
    const fetchMock = mockFetch({ [URL]: reply.hang() });
    const client = createApiLlm({
      models: DEFAULT_API_MODELS,
      client: fakeClient({ timeout: 30, maxRetries: 2 }),
      timeoutMs: 50,
    });
    await expectLlmError(client.generate(request), "timeout");
    expect(fetchMock.callsTo(URL).length).toBeLessThan(3);
  });

  it("sends the key it is given, not the one in the environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-env\n");
    const mock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await createApiLlm({ models: DEFAULT_API_MODELS, apiKey: "sk-ant-chosen" }).generate(request);
    // This SDK sends an API key as a bearer token.
    expect(mock.calls[0]?.headers.get("authorization")).toBe("Bearer sk-ant-chosen");
  });

  it("turns missing credentials into auth", async () => {
    // Keeps the SDK from finding a key or an `ant auth login` profile on this machine.
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID"]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv("ANTHROPIC_CONFIG_DIR", join(tmpdir(), "pochi-no-anthropic-config"));
    mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    const client = new Anthropic({ apiKey: null, authToken: null, maxRetries: 0, fetch: (...args) => fetch(...args) });
    await expectLlmError(llm(client).generate(request), "auth");
  });

  it("rethrows the abort reason instead of an LlmError", async () => {
    mockFetch({ [URL]: reply.hang() });
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = llm().generate(request, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
