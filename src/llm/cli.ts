import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { log } from "../util/log.js";
import {
  type GenerateRequest,
  type LlmClient,
  LlmError,
  type LlmTier,
  PROMPT_TOO_LONG,
  type StatusKind,
  statusKind,
  toJsonSchema,
  validateReply,
} from "./schema.js";

export const DEFAULT_CLI_MODELS: Record<LlmTier, string> = { triage: "haiku", analyze: "sonnet" };

const TIMEOUT_MS = 300_000;
// How long claude gets to exit after SIGINT before it is killed.
const KILL_GRACE_MS = 5_000;
// How long stdout may stay open after claude exits: a process it started can hold the pipe.
const EXIT_DRAIN_MS = 1_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const SYSTEM_FILE = "system.md";

/** node:child_process spawn, narrowed to what the CLI mode uses so tests can pass a fake. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

/**
 * The prompt goes through stdin and the system prompt (the project's details) through systemFile,
 * not here: argv has a length limit and shows up in process lists. No tools and no MCP servers, so fetched text cannot make claude act, only answer. --safe-mode
 * turns off CLAUDE.md, hooks, plugins and skills, so no local configuration runs or steers it.
 */
export function buildCliArgs(req: GenerateRequest<unknown>, model: string, systemFile: string): string[] {
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
    "--safe-mode",
    "--model",
    model,
    "--system-prompt-file",
    systemFile,
  ];
}

/**
 * The environment claude runs with. Without ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, so claude
 * uses its own login rather than billing the API account the user chose not to use. With a gateway
 * (ANTHROPIC_BASE_URL), claude signs in to it with the key or the token, so nothing is removed.
 * Bedrock and Vertex settings always stay: those are set up for claude on purpose.
 */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.ANTHROPIC_BASE_URL?.trim()) return { ...env };
  const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  return rest;
}

/** The model names are already resolved (config over DEFAULT_CLI_MODELS) by the adapter. */
export function createCliLlm(opts: {
  models: Record<LlmTier, string>;
  spawn?: SpawnFn;
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}): LlmClient {
  const run: RunOptions = {
    spawn: opts.spawn ?? nodeSpawn,
    command: opts.command ?? "claude",
    env: opts.env ?? cliEnv(),
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? MAX_STDOUT_BYTES,
  };
  return {
    mode: "cli",
    backend: "claude",
    async generate<T>(req: GenerateRequest<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
      const model = opts.models[req.tier];
      const started = Date.now();
      const exit = await withPrivateDir("pochi-claude-", run.command, signal, async (cwd) => {
        const systemFile = join(cwd, SYSTEM_FILE);
        await writeInput(systemFile, req.system, run.command);
        return runIn(cwd, run, buildCliArgs(req, model, systemFile), req.prompt, model, signal);
      });
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

export interface RunOptions {
  spawn: SpawnFn;
  command: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs fn in a private directory, removed afterwards: outside the project and not the shared temp
 * directory, where anyone could leave a .claude, CLAUDE.md or AGENTS.md for the CLI to pick up.
 */
export async function withPrivateDir<T>(
  prefix: string,
  command: string,
  signal: AbortSignal | undefined,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw abortReason(signal);
  const cwd = await mkdtemp(join(tmpdir(), prefix)).catch((err: NodeJS.ErrnoException) => {
    throw new LlmError("unavailable", `could not create a directory to run ${command} in: ${err.code ?? err.message}`, {
      cause: err,
    });
  });
  try {
    return await fn(cwd);
  } finally {
    // A directory left behind (EBUSY, EACCES) is only litter in the temp directory; failing here
    // would hide the answer, or the error, of the call itself.
    await rm(cwd, { recursive: true, force: true }).catch((err: NodeJS.ErrnoException) => {
      log.debug(`could not remove ${cwd}: ${err.code ?? err.message}`);
    });
  }
}

/**
 * Writes an input file for the CLI into its private directory. A failure (ENOSPC, say) is the
 * machine's, and every later call would hit it too, so it is reported as unavailable.
 */
export async function writeInput(file: string, data: string, command: string): Promise<void> {
  try {
    await writeFile(file, data, { mode: 0o600 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : "error");
    throw new LlmError("unavailable", `could not write the input for ${command}: ${code}`, { cause: err });
  }
}

/**
 * Resolves once the command has exited, also when it was stopped, so no process outlives the call.
 * label (the model, or what the run is for) goes in error messages.
 */
export function runIn(
  cwd: string,
  run: RunOptions,
  args: string[],
  input: string,
  label: string,
  signal: AbortSignal | undefined,
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = run.spawn(run.command, args, { cwd, env: run.env, shell: false, windowsHide: true });
    } catch (err) {
      // Thrown before a process exists, such as ERR_INVALID_ARG_VALUE for a NUL byte in an
      // argument. Its message quotes the argument, so only the code is kept.
      const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : "error");
      reject(new LlmError("unavailable", `could not run ${run.command}: ${code} (${label})`));
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let stopping = false;
    let failure: unknown;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const stop = (reason: unknown) => {
      if (stopping) return;
      stopping = true;
      failure = reason;
      child.kill("SIGINT");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(
      () => stop(new LlmError("timeout", `${run.command} did not answer within ${run.timeoutMs}ms (${label})`)),
      run.timeoutMs,
    );
    const onAbort = () => {
      if (signal) stop(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const exited = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      finish(() => {
        if (stopping) reject(failure);
        else {
          resolve({
            code,
            signal: exitSignal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: stderr.toString("utf8").trim(),
          });
        }
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stopping) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > run.maxBytes) {
        stop(new LlmError("invalid_output", `${run.command} output exceeds ${run.maxBytes} bytes (${label})`));
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
      finish(() => reject(stopping ? failure : llmErr));
    });
    // close waits until every process holding stdout or stderr lets go, which a process claude
    // started may never do. Once claude itself has exited, the wait is bounded.
    child.on("exit", (code: number | null, exitSignal: NodeJS.Signals | null) => {
      const release = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        exited(code, exitSignal);
      };
      if (stopping) release();
      else drainTimer = setTimeout(release, EXIT_DRAIN_MS);
    });
    child.on("close", exited);

    // claude may exit before reading stdin (a bad flag, say); its exit status tells the story.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Some AbortSignal implementations leave reason undefined; the caller still gets an AbortError.
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
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
  terminal_reason: z.string().nullish(),
  total_cost_usd: z.number().nullish(),
});
type Envelope = z.output<typeof EnvelopeSchema>;

// The envelope is one line; a notice printed before it (an update hint, say) must not hide it.
function readEnvelope(stdout: string): Envelope | undefined {
  const lastLine = stdout.trimEnd().split("\n").at(-1) ?? "";
  for (const text of [stdout, lastLine]) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = EnvelopeSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

// Messages are built from status fields only; result holds claude's own text, which can echo the request.
function parseEnvelope<T>(envelope: Envelope, req: GenerateRequest<T>, model: string): T {
  if (envelope.is_error) throw errorFromEnvelope(envelope, model);
  if (envelope.structured_output != null) return validateReply(envelope.structured_output, req.schema, model);
  switch (envelope.stop_reason) {
    case "refusal":
      throw new LlmError("refusal", `Claude declined the request (${model})`);
    case "max_tokens":
    case "model_context_window_exceeded":
      throw new LlmError("max_tokens", `Claude's reply was cut off: ${envelope.stop_reason} (${model})`);
  }
  // Fallback for when claude answers in plain text instead of through the schema.
  const value = findFirstJsonObject(stripAnsi(envelope.result ?? ""));
  if (value === undefined) throw new LlmError("invalid_output", `claude returned no structured output (${model})`);
  return validateReply(value, req.schema, model);
}

const STATUS_MESSAGES: Record<StatusKind, string> = {
  auth: "claude is not logged in or its credentials were rejected",
  rate_limit: "Claude usage limit reached",
  timeout: "Claude timed out",
  transport: "Claude is unavailable",
  unavailable: "claude rejected the request",
  too_large: "the request is too large for Claude",
  bad_request: "Claude rejected the request as invalid",
};

// claude's reply when it has no credentials at all. It sends no request, so there is no status.
const NOT_LOGGED_IN = /not logged in|\/login\b/i;

function errorFromEnvelope(envelope: Envelope, model: string): LlmError {
  // result is only matched here, never quoted.
  if (PROMPT_TOO_LONG.test(envelope.result ?? "")) {
    return new LlmError("too_large", `${STATUS_MESSAGES.too_large} (${model})`);
  }
  const status = envelope.api_error_status;
  if (status != null) {
    const kind = statusKind(status);
    return new LlmError(kind, `${STATUS_MESSAGES[kind]} (HTTP ${status}, ${model})`);
  }
  if (envelope.subtype === "error_max_structured_output_retries") {
    return new LlmError("invalid_output", `Claude kept failing the output schema (${model})`);
  }
  if (NOT_LOGGED_IN.test(envelope.result ?? "")) {
    return new LlmError("auth", `claude is not logged in; run claude and then /login (${model})`);
  }
  // An API error without a status: the request never got a response (refused, DNS, TLS, ...).
  if (envelope.terminal_reason === "api_error") {
    return new LlmError("transport", `claude could not reach the Anthropic API (${model})`);
  }
  // subtype stays "success" on most errors, so terminal_reason says more. Not known to be
  // permanent, so it is retried rather than stopping the run.
  const reason = envelope.terminal_reason ?? envelope.subtype;
  return new LlmError("transport", `claude reported an error: ${reason} (${model})`);
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
    // A { that never closes may be prose; a later one can still hold the reply.
    if (end === -1) continue;
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
