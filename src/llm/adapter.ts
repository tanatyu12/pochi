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
// claude auth status prints a few hundred bytes of JSON.
const MAX_STATUS_BYTES = 64 * 1024;
// claude auth status arrived in 2.1.41 (its changelog). An older claude might take "auth status"
// for a prompt and answer it, so it is not asked.
const CLAUDE_AUTH_STATUS_SINCE = [2, 1, 41] as const;

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
      const client = createCliLlm({ models, spawn, command, env: run.env });
      return { client: { ...client, preflight: ({ signal } = {}) => claudeLoggedIn(run, cliVersion, signal) }, models, cliVersion };
    }
    const models = { triage: llm.triageModel ?? undefined, analyze: llm.analyzeModel ?? undefined };
    log.info(`LLM: cli mode, ${cliVersion} (${models.triage ?? "codex default"} / ${models.analyze ?? "codex default"})`);
    if (!models.triage) {
      // Which models a codex login offers depends on the account, so no smaller one is assumed here.
      log.debug("llm.triageModel is not set, so triage uses codex's default model; a smaller model there costs less");
    }
    const client = createCodexLlm({ models, spawn, command, env: run.env });
    return { client: { ...client, preflight: ({ signal } = {}) => codexLoggedIn(run, signal) }, models, cliVersion };
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

/*
 * The CLI modes check the login only. Neither CLI can tell whether a model name is known without
 * sending it a prompt (which costs tokens), so a mistyped model still fails at the first call.
 * Both checks read the local login and make no request, so a revoked login is not caught either;
 * anything other than a clear "not logged in" lets the run go ahead, so a check that misreads a
 * setup never blocks one that works.
 */

/** claude auth status: JSON with loggedIn, and exit code 1 when logged out (it counts API keys, Bedrock and Vertex). */
async function claudeLoggedIn(run: RunOptions, cliVersion: string, signal: AbortSignal | undefined): Promise<void> {
  if (!atLeast(cliVersion, CLAUDE_AUTH_STATUS_SINCE)) {
    log.debug(`not checking the claude login: ${cliVersion} may not have auth status`);
    return;
  }
  const exit = await runStatus(run, ["auth", "status", "--json"], "pochi-claude-", signal);
  if (!exit) return;
  let loggedIn: unknown;
  try {
    loggedIn = (JSON.parse(exit.stdout) as { loggedIn?: unknown }).loggedIn;
  } catch {
    log.debug(`${run.command} auth status printed no JSON; not checking the login`);
    return;
  }
  if (loggedIn === false) {
    throw new LlmError("auth", `claude is not logged in; run claude and then /login (${run.command} auth status)`);
  }
}

/**
 * codex login status: "Not logged in" and exit code 1 without a login. codex exec also takes
 * CODEX_API_KEY (and OPENAI_API_KEY), which login status does not count, so with either set
 * there is nothing to check.
 */
async function codexLoggedIn(run: RunOptions, signal: AbortSignal | undefined): Promise<void> {
  if (run.env.CODEX_API_KEY?.trim() || run.env.OPENAI_API_KEY?.trim()) return;
  const exit = await runStatus(run, ["login", "status"], "pochi-codex-", signal);
  if (exit && exit.code !== 0 && /not logged in/i.test(`${exit.stdout}\n${exit.stderr}`)) {
    throw new LlmError("auth", `codex is not logged in; run codex login (${run.command} login status)`);
  }
}

/** The exit of a status command, or undefined when it did not run; only an abort is thrown. */
async function runStatus(
  run: RunOptions,
  args: string[],
  prefix: string,
  signal: AbortSignal | undefined,
): Promise<Exit | undefined> {
  const status: RunOptions = { ...run, timeoutMs: PROBE_TIMEOUT_MS, maxBytes: MAX_STATUS_BYTES };
  try {
    return await withPrivateDir(prefix, run.command, signal, (cwd) => runIn(cwd, status, args, "", args.join(" "), signal));
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    log.debug(`${run.command} ${args.join(" ")} did not run: ${err.message}`);
    return undefined;
  }
}

/** Whether a version line ("2.1.314 (Claude Code)") is at least min; false when it has no version. */
function atLeast(versionLine: string, min: readonly number[]): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionLine);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (const [i, want] of min.entries()) {
    const have = parts[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}
