import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import { log } from "../util/log.js";
import {
  type GenerateRequest,
  issuePaths,
  type LlmClient,
  LlmError,
  type LlmTier,
  toJsonSchema,
} from "./schema.js";

export const DEFAULT_CLI_MODELS: Record<LlmTier, string> = { triage: "haiku", analyze: "sonnet" };

const TIMEOUT_MS = 300_000;
// How long claude gets to exit after SIGINT before it is killed.
const KILL_GRACE_MS = 5_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

/** node:child_process spawn, narrowed to what the CLI mode uses so tests can pass a fake. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/**
 * The prompt goes through stdin, not here: argv has a length limit and shows up in process lists.
 * No tools and no MCP servers, so fetched text cannot make claude act, only answer.
 */
export function buildCliArgs(req: GenerateRequest<unknown>, model: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(toJsonSchema(req.schema)),
    "--tools",
    "",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--model",
    model,
    "--system-prompt",
    req.system,
  ];
}

/** The model names are already resolved (config over DEFAULT_CLI_MODELS) by the adapter. */
export function createCliLlm(opts: {
  models: Record<LlmTier, string>;
  spawn?: SpawnFn;
  command?: string;
  timeoutMs?: number;
  maxBytes?: number;
}): LlmClient {
  const run: RunOptions = {
    spawn: opts.spawn ?? nodeSpawn,
    command: opts.command ?? "claude",
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? MAX_STDOUT_BYTES,
  };
  return {
    mode: "cli",
    async generate<T>(req: GenerateRequest<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
      const model = opts.models[req.tier];
      const started = Date.now();
      const exit = await runClaude(run, buildCliArgs(req, model), req.prompt, model, signal);
      const envelope = readEnvelope(exit.stdout);
      if (!envelope) {
        if (exit.stderr) log.debug(`claude stderr: ${exit.stderr}`);
        // The output was cut short or never written; a clean exit with junk on stdout is a format change.
        if (exit.code !== 0) {
          const how = exit.code === null ? `signal ${exit.signal}` : `code ${exit.code}`;
          throw new LlmError("transport", `claude exited with ${how} (${model})`);
        }
        throw new LlmError("invalid_output", `claude printed no result envelope (${model})`);
      }
      const cost = envelope.total_cost_usd == null ? "" : `, $${envelope.total_cost_usd.toFixed(4)}`;
      log.debug(`claude ${model} answered in ${Date.now() - started}ms${cost}`);
      return parseEnvelope(envelope, req, model);
    },
  };
}

interface RunOptions {
  spawn: SpawnFn;
  command: string;
  timeoutMs: number;
  maxBytes: number;
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

// Resolves once claude has exited, also when it was stopped, so no process outlives the call.
function runClaude(
  run: RunOptions,
  args: string[],
  input: string,
  model: string,
  signal: AbortSignal | undefined,
): Promise<Exit> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    // cwd is outside the project so claude does not load its .claude settings or CLAUDE.md.
    const child = run.spawn(run.command, args, { cwd: tmpdir(), shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let failure: unknown;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const stop = (reason: unknown) => {
      if (failure !== undefined) return;
      failure = reason;
      child.kill("SIGINT");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(
      () => stop(new LlmError("timeout", `claude did not answer within ${run.timeoutMs}ms (${model})`)),
      run.timeoutMs,
    );
    const onAbort = () => stop(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure !== undefined) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > run.maxBytes) {
        stop(new LlmError("invalid_output", `claude output exceeds ${run.maxBytes} bytes (${model})`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.byteLength > STDERR_TAIL_BYTES) stderr = stderr.subarray(-STDERR_TAIL_BYTES);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      // Spawning failed: there is no process to wait for.
      const llmErr =
        err.code === "ENOENT"
          ? new LlmError("unavailable", `${run.command} command not found`, { cause: err })
          : new LlmError("transport", `could not run ${run.command}: ${err.code ?? err.message}`, { cause: err });
      finish(() => reject(failure ?? llmErr));
    });
    child.on("close", (code: number | null, exitSignal: NodeJS.Signals | null) => {
      finish(() => {
        if (failure !== undefined) reject(failure);
        else {
          resolve({
            code,
            signal: exitSignal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: stderr.toString("utf8").trim(),
          });
        }
      });
    });

    // claude may exit before reading stdin (a bad flag, say); its exit status tells the story.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Only the fields read below; the envelope carries many more (usage, timings, ...).
const EnvelopeSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().nullish(),
  structured_output: z.unknown().optional(),
  api_error_status: z.number().nullish(),
  stop_reason: z.string().nullish(),
  total_cost_usd: z.number().nullish(),
});
type Envelope = z.output<typeof EnvelopeSchema>;

function readEnvelope(stdout: string): Envelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const parsed = EnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// Messages are built from status fields only; result holds claude's own text, which can echo the request.
function parseEnvelope<T>(envelope: Envelope, req: GenerateRequest<T>, model: string): T {
  if (envelope.is_error) throw errorFromEnvelope(envelope, model);
  if (envelope.structured_output != null) return validate(envelope.structured_output, req, model);
  if (envelope.stop_reason === "refusal") throw new LlmError("refusal", `Claude declined the request (${model})`);
  // Fallback for when claude answers in plain text instead of through the schema.
  const value = findFirstJsonObject(stripAnsi(envelope.result ?? ""));
  if (value === undefined) {
    if (envelope.stop_reason === "max_tokens") {
      throw new LlmError("max_tokens", `Claude's reply was cut off: max_tokens (${model})`);
    }
    throw new LlmError("invalid_output", `claude returned no structured output (${model})`);
  }
  return validate(value, req, model);
}

function errorFromEnvelope(envelope: Envelope, model: string): LlmError {
  const status = envelope.api_error_status;
  if (status == null) {
    if (envelope.subtype === "error_max_structured_output_retries") {
      return new LlmError("invalid_output", `Claude kept failing the output schema (${model})`);
    }
    return new LlmError("transport", `claude failed: ${envelope.subtype} (${model})`);
  }
  const where = `HTTP ${status}, ${model}`;
  if (status === 401 || status === 403) {
    return new LlmError("auth", `claude is not logged in or its credentials were rejected (${where})`);
  }
  if (status === 429) return new LlmError("rate_limit", `Claude usage limit reached (${where})`);
  if (status >= 500) return new LlmError("transport", `Claude is unavailable (${where})`);
  // 400 / 404 and the rest: usually a model name claude does not know, which retrying will not fix.
  return new LlmError("unavailable", `claude rejected the request (${where})`);
}

function validate<T>(value: unknown, req: GenerateRequest<T>, model: string): T {
  const parsed = req.schema.safeParse(value);
  if (!parsed.success) {
    const paths = issuePaths(parsed.error);
    throw new LlmError("invalid_output", `Claude's reply did not match the schema at ${paths} (${model})`);
  }
  return parsed.data;
}

// CSI sequences (colours, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * The first balanced {...} in text that parses as a JSON object. Braces inside JSON strings do
 * not count, and a candidate that fails to parse (prose such as "use {name}") is skipped.
 */
export function findFirstJsonObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = matchingBrace(text, start);
    if (end === -1) return undefined;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Not JSON; try the next brace.
    }
  }
  return undefined;
}

// Index of the } closing the { at start, or -1 if the text ends first.
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
