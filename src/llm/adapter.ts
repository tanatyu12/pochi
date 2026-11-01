import { spawn as nodeSpawn } from "node:child_process";
import type { Context } from "../config/schema.js";
import { log } from "../util/log.js";
import { createApiLlm, DEFAULT_API_MODELS } from "./api.js";
import {
  cliEnv,
  createCliLlm,
  DEFAULT_CLI_MODELS,
  type Exit,
  type RunOptions,
  runIn,
  type SpawnFn,
  withPrivateDir,
} from "./cli.js";
import { createCodexLlm } from "./codex.js";
import { type CliBackend, type LlmClient, LlmError, type LlmTier } from "./schema.js";

// --version only prints and exits; anything slower is a broken install.
const PROBE_TIMEOUT_MS = 10_000;
const MAX_VERSION_CHARS = 200;
const MAX_VERSION_BYTES = 4096;

export interface ResolvedLlm {
  client: LlmClient;
  /** undefined: the CLI's own default model (codex). */
  models: Record<LlmTier, string | undefined>;
  /** What claude --version or codex --version printed (first line), when the CLI mode was chosen. */
  cliVersion?: string;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  /** The claude command. */
  command?: string;
  codexCommand?: string;
  signal?: AbortSignal;
}

/**
 * API mode when ANTHROPIC_API_KEY is set, else CLI mode with claude, else with codex, as provider
 * allows. Throws LlmError (exit 3) when none is usable, before anything is fetched or billed.
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
    const client = createApiLlm({
      models,
      apiKey: key,
      authToken: env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined,
      baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    });
    return { client, models };
  }

  if (platform === "win32") {
    throw new LlmError(
      "unavailable",
      llm.provider === "auto"
        ? "no LLM available: set ANTHROPIC_API_KEY (the CLI mode is not supported on Windows)"
        : "the CLI mode is not supported on Windows; set ANTHROPIC_API_KEY and use the API mode",
    );
  }
  const spawn = opts.spawn ?? nodeSpawn;
  const backends: CliBackend[] =
    llm.provider === "auto" ? ["claude", "codex"] : llm.provider === "codex" ? ["codex"] : ["claude"];
  const tried: string[] = [];
  for (const backend of backends) {
    const run: RunOptions = {
      spawn,
      command: backend === "claude" ? (opts.command ?? "claude") : (opts.codexCommand ?? "codex"),
      env: backend === "claude" ? cliEnv(env) : env,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: MAX_VERSION_BYTES,
    };
    const { command } = run;
    tried.push(command);
    const cliVersion = await probeVersion(run, `pochi-${backend}-`, opts.signal);
    if (cliVersion === undefined) continue;
    if (backend === "claude") {
      const models = resolveModels(llm, DEFAULT_CLI_MODELS);
      log.info(`LLM: cli mode, ${cliVersion} (${models.triage} / ${models.analyze})`);
      return { client: createCliLlm({ models, spawn, command, env: run.env }), models, cliVersion };
    }
    const models = { triage: llm.triageModel ?? undefined, analyze: llm.analyzeModel ?? undefined };
    log.info(`LLM: cli mode, ${cliVersion} (${models.triage ?? "codex default"} / ${models.analyze ?? "codex default"})`);
    return { client: createCodexLlm({ models, spawn, command, env: run.env }), models, cliVersion };
  }
  const probes = tried.map((c) => `${c} --version`).join(" and ");
  throw new LlmError(
    "unavailable",
    llm.provider === "auto"
      ? `no LLM available: set ANTHROPIC_API_KEY or install ${tried.join(" or ")} (${probes} did not succeed)`
      : `llm.provider is ${llm.provider} but ${probes} did not succeed`,
  );
}

function resolveModels(llm: Context["llm"], defaults: Record<LlmTier, string>): Record<LlmTier, string> {
  return { triage: llm.triageModel ?? defaults.triage, analyze: llm.analyzeModel ?? defaults.analyze };
}

/**
 * The first line --version printed, or undefined when it did not run cleanly. Runs the way the
 * CLI mode does (private cwd, the same environment, SIGINT then SIGKILL); only an abort is thrown.
 */
async function probeVersion(run: RunOptions, prefix: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  let exit: Exit;
  try {
    exit = await withPrivateDir(prefix, run.command, signal, (cwd) => runIn(cwd, run, ["--version"], "", "version", signal));
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
