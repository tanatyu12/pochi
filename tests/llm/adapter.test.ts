import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSchema, type Context } from "../../src/config/schema.js";
import { ExitCode, exitCodeOf } from "../../src/errors.js";
import { resolveLlm } from "../../src/llm/adapter.js";
import { DEFAULT_API_MODELS } from "../../src/llm/api.js";
import { DEFAULT_CLI_MODELS } from "../../src/llm/cli.js";
import { LlmError, type LlmErrorKind, TriageOutputSchema } from "../../src/llm/schema.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { fakeSpawn, run } from "../helpers/fakeSpawn.js";

const KEY = "sk-ant-api03-PLANTED-7f3a";
const VERSION = "2.1.310 (Claude Code)\n";

function llmConfig(over: Record<string, unknown> = {}): Context["llm"] {
  return ContextSchema.parse({
    version: 1,
    project: { name: "my-app", description: "" },
    problems: ["anything"],
    llm: over,
  }).llm;
}

async function expectLlmError(promise: Promise<unknown>, kind: LlmErrorKind): Promise<LlmError> {
  const err = await promise.then(
    () => expect.unreachable("expected a rejection"),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LlmError);
  const e = err as LlmError;
  expect(e.kind).toBe(kind);
  expect(exitCodeOf(e)).toBe(ExitCode.LLM);
  expect(e.message).not.toContain(KEY);
  return e;
}

let logs: string[];

beforeEach(() => {
  logs = [];
  configureLog({ level: "verbose", write: (s) => logs.push(s) });
});

afterEach(() => {
  vi.useRealTimers();
  resetLog();
});

describe("resolveLlm with provider auto", () => {
  it("uses the API mode when ANTHROPIC_API_KEY is set, without running claude", async () => {
    const mock = fakeSpawn([]);
    const resolved = await resolveLlm(llmConfig(), { env: { ANTHROPIC_API_KEY: KEY }, spawn: mock.spawn });
    expect(resolved.client.mode).toBe("api");
    expect(resolved.models).toEqual(DEFAULT_API_MODELS);
    expect(resolved.cliVersion).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
    expect(logs.join("")).not.toContain(KEY);
  });

  it("uses the CLI mode when there is no key and claude --version succeeds", async () => {
    const mock = fakeSpawn(run.exit(VERSION));
    const resolved = await resolveLlm(llmConfig(), { env: {}, platform: "darwin", spawn: mock.spawn });
    expect(resolved.client.mode).toBe("cli");
    expect(resolved.models).toEqual(DEFAULT_CLI_MODELS);
    expect(resolved.cliVersion).toBe("2.1.310 (Claude Code)");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.command).toBe("claude");
    expect(mock.calls[0]?.args).toEqual(["--version"]);
    expect(mock.calls[0]?.options.shell).toBe(false);
  });

  it("does not pass a blank key to claude either", async () => {
    const mock = fakeSpawn(run.exit(VERSION));
    await resolveLlm(llmConfig(), { env: { ANTHROPIC_API_KEY: "  " }, platform: "linux", spawn: mock.spawn });
    expect(mock.calls[0]?.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("treats a blank key as not set", async () => {
    const mock = fakeSpawn(run.exit(VERSION));
    const resolved = await resolveLlm(llmConfig(), {
      env: { ANTHROPIC_API_KEY: "  " },
      platform: "linux",
      spawn: mock.spawn,
    });
    expect(resolved.client.mode).toBe("cli");
  });

  it.each([
    ["claude is not installed", run.spawnError("ENOENT")],
    ["claude --version fails", run.exit("", { code: 1, stderr: "boom" })],
    ["claude --version prints nothing", run.exit("")],
  ])("is unavailable when %s", async (_, script) => {
    const mock = fakeSpawn(script);
    const err = await expectLlmError(resolveLlm(llmConfig(), { env: {}, platform: "linux", spawn: mock.spawn }), "unavailable");
    expect(err.message).toContain("ANTHROPIC_API_KEY");
  });

  it("is unavailable when claude and codex --version hang, and stops each with SIGINT, then SIGKILL", async () => {
    vi.useFakeTimers();
    const mock = fakeSpawn(run.hang({ ignoreSigint: true }));
    const promise = expectLlmError(resolveLlm(llmConfig(), { env: {}, platform: "linux", spawn: mock.spawn }), "unavailable");
    await mock.spawned();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.calls[0]?.signals).toEqual(["SIGINT"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.calls[0]?.signals).toEqual(["SIGINT", "SIGKILL"]);
    await mock.spawned(2);
    await vi.advanceTimersByTimeAsync(15_000);
    await promise;
    expect(mock.calls[1]?.command).toBe("codex");
    expect(mock.calls[1]?.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("runs claude --version in a private directory, not the shared temp directory", async () => {
    const mock = fakeSpawn(run.exit(VERSION));
    await resolveLlm(llmConfig(), { env: {}, platform: "linux", spawn: mock.spawn });
    const cwd = String(mock.calls[0]?.options.cwd);
    expect(cwd).not.toBe(tmpdir());
    expect(dirname(cwd)).toBe(tmpdir());
    expect(cwd).toContain("pochi-claude-");
    expect(existsSync(cwd)).toBe(false);
  });

  it("is unavailable on Windows without a key, without running claude", async () => {
    const mock = fakeSpawn([]);
    const err = await expectLlmError(resolveLlm(llmConfig(), { env: {}, platform: "win32", spawn: mock.spawn }), "unavailable");
    expect(err.message).toContain("Windows");
    expect(mock.calls).toHaveLength(0);
  });

  it("uses the API mode on Windows when the key is set", async () => {
    const resolved = await resolveLlm(llmConfig(), { env: { ANTHROPIC_API_KEY: KEY }, platform: "win32" });
    expect(resolved.client.mode).toBe("api");
  });

  it("throws the abort reason when aborted before claude answers", async () => {
    const mock = fakeSpawn(run.hang());
    const controller = new AbortController();
    const promise = resolveLlm(llmConfig(), { env: {}, platform: "linux", spawn: mock.spawn, signal: controller.signal });
    await mock.spawned();
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
  });

  it("throws an AbortError when the signal has no reason", async () => {
    const mock = fakeSpawn(run.hang());
    const signal = Object.assign(new EventTarget(), { aborted: false, reason: undefined }) as unknown as AbortSignal;
    const promise = resolveLlm(llmConfig(), { env: {}, platform: "linux", spawn: mock.spawn, signal });
    await mock.spawned();
    Object.assign(signal, { aborted: true });
    signal.dispatchEvent(new Event("abort"));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("resolveLlm with provider api", () => {
  it("is an auth error without a key, without running claude", async () => {
    const mock = fakeSpawn([]);
    const err = await expectLlmError(
      resolveLlm(llmConfig({ provider: "api" }), { env: {}, platform: "linux", spawn: mock.spawn }),
      "auth",
    );
    expect(err.message).toContain("ANTHROPIC_API_KEY");
    expect(mock.calls).toHaveLength(0);
  });

  it("uses the API mode with a key", async () => {
    const resolved = await resolveLlm(llmConfig({ provider: "api" }), { env: { ANTHROPIC_API_KEY: KEY } });
    expect(resolved.client.mode).toBe("api");
  });
});

describe("resolveLlm with provider cli", () => {
  it("uses the CLI mode even when the key is set", async () => {
    const mock = fakeSpawn(run.exit(VERSION));
    const resolved = await resolveLlm(llmConfig({ provider: "cli" }), {
      env: { ANTHROPIC_API_KEY: KEY },
      platform: "darwin",
      spawn: mock.spawn,
    });
    expect(resolved.client.mode).toBe("cli");
  });

  it("runs claude without ANTHROPIC_API_KEY, so it uses its own login", async () => {
    const mock = fakeSpawn([run.exit(VERSION), run.fixture("structured.json")]);
    const { client } = await resolveLlm(llmConfig({ provider: "cli" }), {
      env: { ANTHROPIC_API_KEY: KEY, PATH: "/usr/bin" },
      platform: "darwin",
      spawn: mock.spawn,
    });
    await client.generate({ system: "s", prompt: "p", schema: TriageOutputSchema, tier: "triage" });
    expect(mock.calls).toHaveLength(2);
    for (const call of mock.calls) expect(call.options.env).toEqual({ PATH: "/usr/bin" });
  });

  it("is unavailable when claude --version fails", async () => {
    const mock = fakeSpawn(run.spawnError("ENOENT"));
    const err = await expectLlmError(
      resolveLlm(llmConfig({ provider: "cli" }), { env: { ANTHROPIC_API_KEY: KEY }, platform: "linux", spawn: mock.spawn }),
      "unavailable",
    );
    expect(err.message).toContain("provider is cli");
  });

  it("is unavailable on Windows", async () => {
    const mock = fakeSpawn([]);
    const err = await expectLlmError(
      resolveLlm(llmConfig({ provider: "cli" }), { env: {}, platform: "win32", spawn: mock.spawn }),
      "unavailable",
    );
    expect(err.message).toContain("Windows");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("model names", () => {
  it.each([{}, { triageModel: null, analyzeModel: null }])("fall back to the mode's defaults (%o)", async (over) => {
    expect((await resolveLlm(llmConfig(over), { env: { ANTHROPIC_API_KEY: KEY } })).models).toEqual(DEFAULT_API_MODELS);
    const mock = fakeSpawn(run.exit(VERSION));
    expect((await resolveLlm(llmConfig(over), { env: {}, platform: "linux", spawn: mock.spawn })).models).toEqual(
      DEFAULT_CLI_MODELS,
    );
  });

  it("use the configured names in both modes", async () => {
    const config = llmConfig({ triageModel: "claude-haiku-4-5", analyzeModel: "opus" });
    const expected = { triage: "claude-haiku-4-5", analyze: "opus" };
    expect((await resolveLlm(config, { env: { ANTHROPIC_API_KEY: KEY } })).models).toEqual(expected);
    const mock = fakeSpawn(run.exit(VERSION));
    expect((await resolveLlm(config, { env: {}, platform: "linux", spawn: mock.spawn })).models).toEqual(expected);
  });

  it("are the ones the CLI client runs claude with", async () => {
    const mock = fakeSpawn([run.exit(VERSION), run.fixture("structured.json")]);
    const { client } = await resolveLlm(llmConfig({ triageModel: "haiku-x" }), {
      env: {},
      platform: "linux",
      spawn: mock.spawn,
    });
    await client.generate({ system: "s", prompt: "p", schema: TriageOutputSchema, tier: "triage" });
    const args = mock.calls[1]?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("haiku-x");
  });
});

describe("resolveLlm with codex", () => {
  const CODEX_VERSION = "codex-cli 0.120.0\n";

  it("falls back to codex in auto when claude --version fails", async () => {
    const mock = fakeSpawn([run.spawnError("ENOENT"), run.exit(CODEX_VERSION)]);
    const resolved = await resolveLlm(llmConfig(), { env: {}, platform: "darwin", spawn: mock.spawn });
    expect(resolved.client.backend).toBe("codex");
    expect(resolved.cliVersion).toBe("codex-cli 0.120.0");
    expect(resolved.models).toEqual({ triage: undefined, analyze: undefined });
    expect(mock.calls.map((c) => c.command)).toEqual(["claude", "codex"]);
    expect(mock.calls[1]?.args).toEqual(["--version"]);
    expect(String(mock.calls[1]?.options.cwd)).toContain("pochi-codex-");
  });

  it("prefers claude in auto when both are installed", async () => {
    const mock = fakeSpawn([run.exit(VERSION)]);
    const resolved = await resolveLlm(llmConfig(), { env: {}, platform: "darwin", spawn: mock.spawn });
    expect(resolved.client.backend).toBe("claude");
    expect(mock.calls).toHaveLength(1);
  });

  it("names both commands when neither runs", async () => {
    const mock = fakeSpawn(run.spawnError("ENOENT"));
    const err = await expectLlmError(resolveLlm(llmConfig(), { env: {}, platform: "linux", spawn: mock.spawn }), "unavailable");
    expect(err.message).toContain("install claude or codex");
  });

  it("uses only codex with provider codex, even when the key is set", async () => {
    const mock = fakeSpawn([run.exit(CODEX_VERSION)]);
    const resolved = await resolveLlm(llmConfig({ provider: "codex" }), {
      env: { ANTHROPIC_API_KEY: KEY },
      platform: "darwin",
      spawn: mock.spawn,
      codexCommand: "/opt/codex",
    });
    expect(resolved.client.mode).toBe("cli");
    expect(resolved.client.backend).toBe("codex");
    expect(mock.calls.map((c) => c.command)).toEqual(["/opt/codex"]);
  });

  it("is unavailable with provider codex when codex --version fails, without trying claude", async () => {
    const mock = fakeSpawn([run.spawnError("ENOENT")]);
    const err = await expectLlmError(
      resolveLlm(llmConfig({ provider: "codex" }), { env: {}, platform: "linux", spawn: mock.spawn }),
      "unavailable",
    );
    expect(err.message).toContain("provider is codex but codex --version");
    expect(mock.calls).toHaveLength(1);
  });

  it("does not try codex with provider cli or claude", async () => {
    for (const provider of ["cli", "claude"]) {
      const mock = fakeSpawn([run.spawnError("ENOENT")]);
      await expectLlmError(
        resolveLlm(llmConfig({ provider }), { env: {}, platform: "linux", spawn: mock.spawn }),
        "unavailable",
      );
      expect(mock.calls.map((c) => c.command)).toEqual(["claude"]);
    }
  });

  it("is unavailable on Windows", async () => {
    const mock = fakeSpawn([]);
    const err = await expectLlmError(
      resolveLlm(llmConfig({ provider: "codex" }), { env: {}, platform: "win32", spawn: mock.spawn }),
      "unavailable",
    );
    expect(err.message).toContain("Windows");
    expect(mock.calls).toHaveLength(0);
  });

  it("runs codex with the configured models", async () => {
    const mock = fakeSpawn([run.exit(CODEX_VERSION), run.hang()]);
    const controller = new AbortController();
    const { client, models } = await resolveLlm(llmConfig({ provider: "codex", analyzeModel: "gpt-big" }), {
      env: {},
      platform: "linux",
      spawn: mock.spawn,
    });
    expect(models).toEqual({ triage: undefined, analyze: "gpt-big" });
    const promise = client.generate(
      { system: "s", prompt: "p", schema: TriageOutputSchema, tier: "analyze" },
      { signal: controller.signal },
    );
    await mock.spawned(2);
    controller.abort(new Error("stop"));
    await expect(promise).rejects.toThrow("stop");
    const args = mock.calls[1]?.args ?? [];
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-big");
  });
});
