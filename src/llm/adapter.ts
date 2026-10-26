import { spawn as nodeSpawn } from "node:child_process";
import type { Context } from "../config/schema.js";
import { log } from "../util/log.js";
import { createApiLlm, DEFAULT_API_MODELS } from "./api.js";
import { cliEnv, createCliLlm, DEFAULT_CLI_MODELS, type Exit, type RunOptions, runClaude, type SpawnFn } from "./cli.js";
import { type LlmClient, LlmError, type LlmTier } from "./schema.js";

// claude --version only prints and exits; anything slower is a broken install.
const PROBE_TIMEOUT_MS = 10_000;
const MAX_VERSION_CHARS = 200;
const MAX_VERSION_BYTES = 4096;

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
  // The client gets this same trimmed key, so the mode and the credentials cannot disagree.
  const key = env.ANTHROPIC_API_KEY?.trim() || undefined;

  if (llm.provider === "api" || (llm.provider === "auto" && key)) {
    if (!key) throw new LlmError("auth", "llm.provider is api but ANTHROPIC_API_KEY is not set");
    const models = resolveModels(llm, DEFAULT_API_MODELS);
    log.info(`LLM: api mode (${models.triage} / ${models.analyze})`);
    return { client: createApiLlm({ models, apiKey: key }), models };
  }

  if (platform === "win32") {
    throw new LlmError(
      "unavailable",
      llm.provider === "cli"
        ? "the CLI mode is not supported on Windows; set ANTHROPIC_API_KEY and use the API mode"
        : "no LLM available: set ANTHROPIC_API_KEY (the CLI mode is not supported on Windows)",
    );
  }
  const run: RunOptions = {
    spawn: opts.spawn ?? nodeSpawn,
    command: opts.command ?? "claude",
    env: cliEnv(env),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBytes: MAX_VERSION_BYTES,
  };
  const { command } = run;
  const cliVersion = await probeClaude(run, opts.signal);
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
  return { client: createCliLlm({ models, spawn: run.spawn, command, env: run.env }), models, cliVersion };
}

function resolveModels(llm: Context["llm"], defaults: Record<LlmTier, string>): Record<LlmTier, string> {
  return { triage: llm.triageModel ?? defaults.triage, analyze: llm.analyzeModel ?? defaults.analyze };
}

/**
 * The first line claude --version printed, or undefined when it did not run cleanly. Runs the way
 * the CLI mode does (private cwd, no API key, SIGINT then SIGKILL); only an abort is thrown.
 */
async function probeClaude(run: RunOptions, signal: AbortSignal | undefined): Promise<string | undefined> {
  let exit: Exit;
  try {
    exit = await runClaude(run, ["--version"], "", "version", signal);
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    log.debug(`${run.command} --version did not run: ${err.message}`);
    return undefined;
  }
  const line = exit.stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (exit.code !== 0 || !line) {
    log.debug(`${run.command} --version exited with ${exit.code ?? `signal ${exit.signal}`}`);
    return undefined;
  }
  return line.slice(0, MAX_VERSION_CHARS);
}
