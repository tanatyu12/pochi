import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { Context } from "../config/schema.js";
import { log } from "../util/log.js";
import { createApiLlm, DEFAULT_API_MODELS } from "./api.js";
import { createCliLlm, DEFAULT_CLI_MODELS, type SpawnFn } from "./cli.js";
import { type LlmClient, LlmError, type LlmTier } from "./schema.js";

// claude --version only prints and exits; anything slower is a broken install.
const PROBE_TIMEOUT_MS = 10_000;
const MAX_VERSION_CHARS = 200;

export interface ResolvedLlm {
  client: LlmClient;
  models: Record<LlmTier, string>;
  /** What claude --version printed (first line), when the CLI mode was chosen. */
  cliVersion?: string;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  command?: string;
  signal?: AbortSignal;
}

/**
 * API mode when ANTHROPIC_API_KEY is set, else CLI mode when claude runs, as provider allows.
 * Throws LlmError (exit 3) when neither is usable, before anything is fetched or billed.
 */
export async function resolveLlm(llm: Context["llm"], opts: ResolveOptions = {}): Promise<ResolvedLlm> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const hasKey = Boolean(env.ANTHROPIC_API_KEY?.trim());

  if (llm.provider === "api" || (llm.provider === "auto" && hasKey)) {
    if (!hasKey) throw new LlmError("auth", "llm.provider is api but ANTHROPIC_API_KEY is not set");
    const models = resolveModels(llm, DEFAULT_API_MODELS);
    log.info(`LLM: api mode (${models.triage} / ${models.analyze})`);
    return { client: createApiLlm({ models }), models };
  }

  if (platform === "win32") {
    throw new LlmError(
      "unavailable",
      llm.provider === "cli"
        ? "the CLI mode is not supported on Windows; set ANTHROPIC_API_KEY and use the API mode"
        : "no LLM available: set ANTHROPIC_API_KEY (the CLI mode is not supported on Windows)",
    );
  }
  const spawn = opts.spawn ?? nodeSpawn;
  const command = opts.command ?? "claude";
  const cliVersion = await probeClaude(spawn, command, opts.signal);
  if (cliVersion === undefined) {
    throw new LlmError(
      "unavailable",
      llm.provider === "cli"
        ? `llm.provider is cli but ${command} --version did not succeed`
        : `no LLM available: set ANTHROPIC_API_KEY or install ${command} (${command} --version did not succeed)`,
    );
  }
  const models = resolveModels(llm, DEFAULT_CLI_MODELS);
  log.info(`LLM: cli mode, ${cliVersion} (${models.triage} / ${models.analyze})`);
  return { client: createCliLlm({ models, spawn, command }), models, cliVersion };
}

function resolveModels(llm: Context["llm"], defaults: Record<LlmTier, string>): Record<LlmTier, string> {
  return { triage: llm.triageModel ?? defaults.triage, analyze: llm.analyzeModel ?? defaults.analyze };
}

/** The first line claude --version printed, or undefined when it did not run cleanly. */
function probeClaude(spawn: SpawnFn, command: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, ["--version"], { cwd: tmpdir(), shell: false, windowsHide: true });
    } catch (err) {
      log.debug(`could not run ${command} --version: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
      resolve(undefined);
      return;
    }
    const stdout: Buffer[] = [];
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const timer = setTimeout(() => {
      log.debug(`${command} --version did not exit within ${PROBE_TIMEOUT_MS}ms`);
      child.kill("SIGKILL");
      finish(() => resolve(undefined));
    }, PROBE_TIMEOUT_MS);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(signal!.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 16) stdout.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (err: NodeJS.ErrnoException) => {
      log.debug(`could not run ${command} --version: ${err.code ?? "error"}`);
      finish(() => resolve(undefined));
    });
    child.on("close", (code: number | null) => {
      const line = Buffer.concat(stdout).toString("utf8").trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (code !== 0 || !line) log.debug(`${command} --version exited with ${code ?? "a signal"}`);
      finish(() => resolve(code === 0 && line ? line.slice(0, MAX_VERSION_CHARS) : undefined));
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}
