import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExitCode, exitCodeOf } from "../../src/errors.js";
import type { SpawnFn } from "../../src/llm/cli.js";
import { buildCodexArgs, createCodexLlm } from "../../src/llm/codex.js";
import {
  type GenerateRequest,
  LlmError,
  type LlmErrorKind,
  toJsonSchema,
  TriageOutputSchema,
  type TriageOutput,
} from "../../src/llm/schema.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { type FakeChild, fakeSpawn, run, type Script } from "../helpers/fakeSpawn.js";

// Planted in the prompt, the system prompt and codex's output; no error message may carry it.
const SECRET = "PLANTED-7f3a";

const request: GenerateRequest<TriageOutput> = {
  system: `system prompt ${SECRET}`,
  prompt: `items ${SECRET}`,
  schema: TriageOutputSchema,
  tier: "triage",
};

const answer: TriageOutput = { decisions: [{ id: "i1", relevant: true, reason: "breaking change" }] };

// Shaped after the codex exec --json events in the Codex docs; tests/fixtures/codex holds real ones.
const STARTED = [{ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }];
const COMPLETED = { type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 80 } };
const failed = (message: string) => ({ type: "turn.failed", error: { message: `${message} ${SECRET}` } });

const jsonl = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

function argAfter(child: FakeChild, flag: string): string {
  const args = child.call.args;
  return args[args.indexOf(flag) + 1]!;
}

/** Writes the final message where -o points, then prints the events, the way codex exec does. */
function codex(opts: { output?: string; events?: unknown[]; code?: number; stderr?: string }): Script {
  return (child) => {
    void child.stdinEnded().then(() => {
      if (opts.output !== undefined) writeFileSync(argAfter(child, "--output-last-message"), opts.output);
      child.stdout.write(jsonl(opts.events ?? [...STARTED, COMPLETED]));
      if (opts.stderr) child.stderr.write(opts.stderr);
      child.exit(opts.code ?? 0);
    });
  };
}

function llm(spawn: SpawnFn, models: { triage?: string; analyze?: string } = {}) {
  return createCodexLlm({ models: { triage: models.triage, analyze: models.analyze }, spawn });
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
  expect(e.message).not.toContain(SECRET);
  return e;
}

afterEach(() => {
  vi.useRealTimers();
  resetLog();
});

describe("buildCodexArgs", () => {
  it("builds the arguments in this exact order", () => {
    expect(buildCodexArgs("/tmp/pochi-codex-x", "gpt-mini")).toMatchSnapshot();
  });

  it("disables the shell, web search and local configuration and reads the prompt from stdin", () => {
    const args = buildCodexArgs("/tmp/d", undefined);
    expect(args[0]).toBe("exec");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("project_doc_max_bytes=0");
    expect(args).toContain('model_instructions_file="/tmp/d/system.md"');
    expect(args).not.toContain("--model");
    expect(args.at(-1)).toBe("-");
  });
});

describe("createCodexLlm", () => {
  it("returns the final message, validated", async () => {
    const { spawn } = fakeSpawn(codex({ output: JSON.stringify(answer) }));
    const client = llm(spawn);
    expect(client.mode).toBe("cli");
    expect(client.backend).toBe("codex");
    await expect(client.generate(request)).resolves.toEqual(answer);
  });

  it("passes the prompt on stdin, the schema and system prompt as files, in a private temp directory", async () => {
    let schema: unknown;
    let system = "";
    const { spawn, calls } = fakeSpawn((child) => {
      schema = JSON.parse(readFileSync(argAfter(child, "--output-schema"), "utf8"));
      system = readFileSync(join(String(child.call.options.cwd), "system.md"), "utf8");
      codex({ output: JSON.stringify(answer) })(child);
    });
    await llm(spawn).generate(request);
    const call = calls[0]!;
    expect(call.command).toBe("codex");
    expect(call.stdin).toBe(request.prompt);
    expect(call.options).toMatchObject({ shell: false });
    const cwd = String(call.options.cwd);
    expect(cwd.startsWith(join(tmpdir(), "pochi-codex-"))).toBe(true);
    expect(existsSync(cwd)).toBe(false);
    expect(call.args).toEqual(buildCodexArgs(cwd, undefined));
    expect(call.args.join("\n")).not.toContain(SECRET);
    expect(schema).toEqual(toJsonSchema(TriageOutputSchema));
    expect(system).toBe(request.system);
  });

  it.each([
    ["triage", "mini"],
    ["analyze", "full"],
  ] as const)("uses the %s tier's model when one is configured", async (tier, model) => {
    const { spawn, calls } = fakeSpawn(codex({ output: JSON.stringify(answer) }));
    await llm(spawn, { triage: "mini", analyze: "full" }).generate({ ...request, tier });
    const args = calls[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe(model);
  });

  it("finds the JSON in a final message with text around it", async () => {
    const { spawn } = fakeSpawn(codex({ output: `Here it is:\n${JSON.stringify(answer)}\n` }));
    await expect(llm(spawn).generate(request)).resolves.toEqual(answer);
  });

  it("ignores errors codex retried past when the turn completed", async () => {
    const events = [...STARTED, { type: "error", message: "Reconnecting... 1/5" }, COMPLETED];
    const { spawn } = fakeSpawn(codex({ output: JSON.stringify(answer), events }));
    await expect(llm(spawn).generate(request)).resolves.toEqual(answer);
  });

  it("logs the tokens used, not the reply", async () => {
    const lines: string[] = [];
    configureLog({ level: "verbose", write: (s) => lines.push(s) });
    const { spawn } = fakeSpawn(codex({ output: JSON.stringify(answer) }));
    await llm(spawn).generate(request);
    expect(lines.join("")).toContain("1200 in / 80 out");
    expect(lines.join("")).not.toContain("breaking change");
  });

  it("is invalid_output when the reply does not match the schema", async () => {
    const { spawn } = fakeSpawn(codex({ output: JSON.stringify({ decisions: [{ id: SECRET }] }) }));
    await expectLlmError(llm(spawn).generate(request), "invalid_output");
  });

  it("is invalid_output when the final message holds no JSON", async () => {
    const { spawn } = fakeSpawn(codex({ output: `no json ${SECRET}` }));
    await expectLlmError(llm(spawn).generate(request), "invalid_output");
  });

  it("is invalid_output when codex exits cleanly without a final message", async () => {
    const { spawn } = fakeSpawn(codex({}));
    await expectLlmError(llm(spawn).generate(request), "invalid_output");
  });

  it("is transport when codex fails without saying why", async () => {
    const { spawn } = fakeSpawn(codex({ events: [], code: 1, stderr: `boom ${SECRET}` }));
    const err = await expectLlmError(llm(spawn).generate(request), "transport");
    expect(err.message).toContain("code 1");
  });

  it.each([
    ["not logged in", "Not logged in. Run codex login.", "auth"],
    ["401", "unexpected status 401 Unauthorized", "auth"],
    ["usage limit", "You've hit your usage limit. Try again later.", "rate_limit"],
    ["429", "exceeded retry limit, last status: 429 Too Many Requests", "rate_limit"],
    ["context window", "Your input exceeds the context window of this model.", "too_large"],
    ["unknown model", "The model `gpt-nope` does not exist", "unavailable"],
    ["5xx", "unexpected status 503 Service Unavailable", "transport"],
    ["400", "unexpected status 400 Bad Request", "bad_request"],
    ["disconnect", "stream disconnected before completion", "transport"],
  ] as const)("maps a failed turn (%s) without quoting it", async (_, message, kind) => {
    const { spawn } = fakeSpawn(codex({ events: [...STARTED, failed(message)], code: 1 }));
    await expectLlmError(llm(spawn).generate(request), kind);
  });

  it("maps the events codex-cli 0.165.0 prints for a model it does not know", async () => {
    const events = readFileSync(new URL("../fixtures/codex/error-model.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const { spawn } = fakeSpawn(codex({ events, code: 1 }));
    await expectLlmError(llm(spawn).generate(request), "unavailable");
  });

  it("maps an error event when there is no failed turn", async () => {
    const event = { type: "error", message: `You've hit your usage limit ${SECRET}` };
    const { spawn } = fakeSpawn(codex({ events: [...STARTED, event], code: 1 }));
    await expectLlmError(llm(spawn).generate(request), "rate_limit");
  });

  it("reports a missing codex command as unavailable", async () => {
    const { spawn } = fakeSpawn(run.spawnError("ENOENT"));
    const err = await expectLlmError(llm(spawn).generate(request), "unavailable");
    expect(err.message).toContain("codex command not found");
  });

  it("stops codex with SIGINT at the timeout", async () => {
    vi.useFakeTimers();
    const mock = fakeSpawn(run.hang());
    const promise = expectLlmError(
      createCodexLlm({ models: { triage: undefined, analyze: undefined }, spawn: mock.spawn, timeoutMs: 1000 }).generate(
        request,
      ),
      "timeout",
    );
    await mock.spawned();
    await vi.advanceTimersByTimeAsync(1000);
    const err = await promise;
    expect(err.message).toContain("codex did not answer");
    expect(mock.calls[0]?.signals).toEqual(["SIGINT"]);
  });

  it("stops codex and rethrows the reason when the caller aborts", async () => {
    const mock = fakeSpawn(run.hang());
    const controller = new AbortController();
    const promise = llm(mock.spawn).generate(request, { signal: controller.signal });
    await mock.spawned();
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(mock.calls[0]?.signals).toEqual(["SIGINT"]);
  });
});
