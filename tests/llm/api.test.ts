import { afterEach, describe, expect, it, vi } from "vitest";
import { ExitCode, exitCodeOf } from "../../src/errors.js";
import { type ApiLlmOptions, createApiLlm, DEFAULT_API_MODELS } from "../../src/llm/api.js";
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

// Retries are on as in production, with a backoff short enough for tests.
function llm(opts: Partial<ApiLlmOptions> = {}) {
  return createApiLlm({ models: DEFAULT_API_MODELS, apiKey: "sk-ant-test", retryBaseMs: 1, ...opts });
}

function delayed(r: Reply, times: number[]): Reply {
  return (req, signal) => {
    times.push(Date.now());
    return r(req, signal);
  };
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

function apiError(status: number, type: string, headers: Record<string, string> = {}): Reply {
  return reply.json(
    { type: "error", error: { type, message: `echo of the request: ${SECRET}` } },
    { status, headers: { "request-id": "req_123", ...headers } },
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
    await llm({ models: { triage: "my-triage", analyze: "my-analyze" } }).generate(request);
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
    await llm({ models: { triage: model, analyze: model } }).generate(request);
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
    [400, "invalid_request_error", "bad_request"],
    [404, "not_found_error", "unavailable"],
    [413, "request_too_large", "too_large"],
  ] as const)("turns HTTP %i into %s", async (status, type, kind) => {
    mockFetch({ [URL]: apiError(status, type, { "retry-after-ms": "0" }) });
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
    await expectLlmError(llm({ timeoutMs: 20 }).generate(request), "timeout");
  });

  it("bounds the whole call, retries included", async () => {
    const fetchMock = mockFetch({ [URL]: [apiError(529, "overloaded_error"), reply.hang()] });
    await expectLlmError(llm({ timeoutMs: 50 }).generate(request), "timeout");
    expect(fetchMock.callsTo(URL)).toHaveLength(2);
  });

  it("does not wait for a retry that would end after the deadline", async () => {
    const fetchMock = mockFetch({ [URL]: apiError(529, "overloaded_error", { "retry-after": "1" }) });
    const err = await expectLlmError(llm({ timeoutMs: 500 }).generate(request), "transport");
    expect(err.message).toContain("HTTP 529 overloaded_error");
    expect(fetchMock.callsTo(URL)).toHaveLength(1);
  });

  it("sends the key it is given, not the one in the environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-env\n");
    const mock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await createApiLlm({ models: DEFAULT_API_MODELS, apiKey: "sk-ant-chosen" }).generate(request);
    expect(mock.calls[0]?.headers.get("x-api-key")).toBe("sk-ant-chosen");
    expect(mock.calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("posts JSON with the API version", async () => {
    const mock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await llm().generate(request);
    expect(mock.calls[0]?.method).toBe("POST");
    expect(mock.calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(mock.calls[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("sends an auth token as a bearer token when there is no key", async () => {
    const mock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await llm({ apiKey: undefined, authToken: "token-1" }).generate(request);
    expect(mock.calls[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(mock.calls[0]?.headers.has("x-api-key")).toBe(false);
  });

  it("prefers the key over an auth token", async () => {
    const mock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    await llm({ authToken: "token-1" }).generate(request);
    expect(mock.calls[0]?.headers.get("x-api-key")).toBe("sk-ant-test");
    expect(mock.calls[0]?.headers.has("authorization")).toBe(false);
  });

  it.each([
    ["https://gateway.example.com", "https://gateway.example.com/v1/messages"],
    ["https://gateway.example.com/anthropic/", "https://gateway.example.com/anthropic/v1/messages"],
    ["  ", URL],
  ])("sends to the base URL %j", async (baseUrl, expected) => {
    const mock = mockFetch({ [expected]: reply.json(message(JSON.stringify(ok))) });
    await expect(llm({ baseUrl }).generate(request)).resolves.toEqual(ok);
    expect(mock.calls).toHaveLength(1);
  });

  it("rejects a base URL that is not http(s) without quoting it", () => {
    let err: unknown;
    try {
      llm({ baseUrl: `file:///${SECRET}` });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).not.toContain(SECRET);
  });

  it.each([
    [529, "overloaded_error"],
    [500, "api_error"],
    [429, "rate_limit_error"],
    [408, "timeout_error"],
    [409, "conflict_error"],
  ] as const)("retries HTTP %i and returns the reply that follows", async (status, type) => {
    const fetchMock = mockFetch({ [URL]: [apiError(status, type), reply.json(message(JSON.stringify(ok)))] });
    await expect(llm().generate(request)).resolves.toEqual(ok);
    expect(fetchMock.callsTo(URL)).toHaveLength(2);
  });

  it("gives up after two retries", async () => {
    const fetchMock = mockFetch({ [URL]: apiError(529, "overloaded_error") });
    const err = await expectLlmError(llm().generate(request), "transport");
    expect(err.message).toContain("HTTP 529 overloaded_error");
    expect(fetchMock.callsTo(URL)).toHaveLength(3);
  });

  it("retries a connection error", async () => {
    const fetchMock = mockFetch({ [URL]: [reply.networkError(), reply.json(message(JSON.stringify(ok)))] });
    await expect(llm().generate(request)).resolves.toEqual(ok);
    expect(fetchMock.callsTo(URL)).toHaveLength(2);
  });

  it.each([400, 401, 404, 413])("does not retry HTTP %i", async (status) => {
    const fetchMock = mockFetch({ [URL]: apiError(status, "invalid_request_error") });
    await failure(llm().generate(request));
    expect(fetchMock.callsTo(URL)).toHaveLength(1);
  });

  it("follows x-should-retry over the status", async () => {
    const fetchMock = mockFetch({ [URL]: apiError(500, "api_error", { "x-should-retry": "false" }) });
    await expectLlmError(llm().generate(request), "transport");
    expect(fetchMock.callsTo(URL)).toHaveLength(1);
  });

  it.each([
    ["retry-after", "1", 1000],
    ["retry-after-ms", "150", 150],
  ])("waits as long as %s asks before retrying", async (header, value, ms) => {
    const times: number[] = [];
    mockFetch({
      [URL]: [
        delayed(apiError(429, "rate_limit_error", { [header]: value }), times),
        delayed(reply.json(message(JSON.stringify(ok))), times),
      ],
    });
    await expect(llm().generate(request)).resolves.toEqual(ok);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(ms - 10);
  });

  it("fails at once when retry-after asks for more than a minute", async () => {
    const fetchMock = mockFetch({ [URL]: apiError(429, "rate_limit_error", { "retry-after": "120" }) });
    await expectLlmError(llm().generate(request), "rate_limit");
    expect(fetchMock.callsTo(URL)).toHaveLength(1);
  });

  it("rethrows the abort reason while waiting to retry", async () => {
    mockFetch({ [URL]: apiError(529, "overloaded_error", { "retry-after": "30" }) });
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = llm().generate(request, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    await expect(pending).rejects.toBe(reason);
  });

  it("puts the status, error type and request id in the message", async () => {
    mockFetch({ [URL]: apiError(529, "overloaded_error", { "x-should-retry": "false" }) });
    const err = await expectLlmError(llm().generate(request), "transport");
    expect(err.message).toBe(
      "Anthropic API is unavailable (HTTP 529 overloaded_error, claude-haiku-5-5, request req_123)",
    );
  });

  it("names only the status when the error body is not JSON", async () => {
    mockFetch({ [URL]: reply.text(`<html>${SECRET}</html>`, { status: 502 }) });
    const err = await expectLlmError(llm({ maxRetries: 0 }).generate(request), "transport");
    expect(err.message).toBe("Anthropic API is unavailable (HTTP 502, claude-haiku-5-5)");
  });

  it.each([
    ["a body that is not JSON", reply.text(`oops ${SECRET}`)],
    ["a body without content", reply.json({ id: "msg_1", stop_reason: "end_turn" })],
    ["content that is not a list", reply.json({ ...message(null), content: SECRET })],
  ])("turns %s into invalid_output", async (_name, r) => {
    const fetchMock = mockFetch({ [URL]: r });
    await expectLlmError(llm().generate(request), "invalid_output");
    expect(fetchMock.callsTo(URL)).toHaveLength(1);
  });

  it("turns a 400 for a prompt over the context window into too_large, without quoting it", async () => {
    mockFetch({
      [URL]: reply.json(
        { type: "error", error: { type: "invalid_request_error", message: `prompt is too long: 250000 tokens ${SECRET}` } },
        { status: 400 },
      ),
    });
    const err = await expectLlmError(llm().generate(request), "too_large");
    expect(err.message).toContain("HTTP 400");
  });

  it("turns missing credentials into auth without reading the environment or sending anything", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-env");
    const fetchMock = mockFetch({ [URL]: reply.json(message(JSON.stringify(ok))) });
    const err = await expectLlmError(llm({ apiKey: undefined }).generate(request), "auth");
    expect(err.message).toContain("ANTHROPIC_API_KEY");
    expect(fetchMock.calls).toHaveLength(0);
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
