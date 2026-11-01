import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { log } from "../util/log.js";
import {
  type Exit,
  findFirstJsonObject,
  type RunOptions,
  runIn,
  type SpawnFn,
  withPrivateDir,
  writeInput,
} from "./cli.js";
import {
  type GenerateRequest,
  type LlmClient,
  LlmError,
  type LlmTier,
  PROMPT_TOO_LONG,
  statusKind,
  toJsonSchema,
  validateReply,
} from "./schema.js";

const TIMEOUT_MS = 300_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const SCHEMA_FILE = "schema.json";
const SYSTEM_FILE = "system.md";
const OUTPUT_FILE = "out.json";

/**
 * Arguments for codex exec, run in cwd. The prompt goes through stdin (the trailing -). The system
 * prompt replaces codex's own instructions (model_instructions_file). Read-only sandbox, no shell
 * tool and no web search, so fetched text cannot make codex act, only answer. --ignore-user-config
 * leaves out config.toml (MCP servers, profiles) and project_doc_max_bytes=0 any AGENTS.md, so no
 * local configuration steers it. Without a model, codex uses the one its login defaults to.
 */
export function buildCodexArgs(cwd: string, model: string | undefined): string[] {
  return [
    "exec",
    "--json",
    "--output-schema",
    join(cwd, SCHEMA_FILE),
    "--output-last-message",
    join(cwd, OUTPUT_FILE),
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "-c",
    `model_instructions_file=${JSON.stringify(join(cwd, SYSTEM_FILE))}`,
    "-c",
    "features.shell_tool=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "project_doc_max_bytes=0",
    ...(model ? ["--model", model] : []),
    "-",
  ];
}

/** Model names are resolved (config, else codex's default) by the adapter. */
export function createCodexLlm(opts: {
  models: Record<LlmTier, string | undefined>;
  spawn?: SpawnFn;
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}): LlmClient {
  const run: RunOptions = {
    spawn: opts.spawn ?? nodeSpawn,
    command: opts.command ?? "codex",
    env: opts.env ?? process.env,
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? MAX_STDOUT_BYTES,
  };
  return {
    mode: "cli",
    backend: "codex",
    async generate<T>(req: GenerateRequest<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
      const model = opts.models[req.tier];
      const label = model ?? "codex default";
      const started = Date.now();
      const { exit, output } = await withPrivateDir("pochi-codex-", run.command, signal, async (cwd) => {
        await writeInput(join(cwd, SCHEMA_FILE), JSON.stringify(toJsonSchema(req.schema)), run.command);
        await writeInput(join(cwd, SYSTEM_FILE), req.system, run.command);
        const exit = await runIn(cwd, run, buildCodexArgs(cwd, model), req.prompt, label, signal);
        // Missing when codex failed before answering; the events then say why.
        const output = await readFile(join(cwd, OUTPUT_FILE), "utf8").catch(() => "");
        return { exit, output };
      });
      const events = readEvents(exit.stdout);
      const completed = events.findLast((e) => e.type === "turn.completed");
      // codex also prints error events for attempts it then retried, so they only count when the
      // turn did not complete.
      const failure = completed ? undefined : events.findLast((e) => e.type === "turn.failed" || e.type === "error");
      if (failure || !output.trim()) {
        if (exit.stderr) log.debug(`codex stderr: ${exit.stderr}`);
        throw failure ? errorFromEvent(failure, label) : noAnswer(exit, label);
      }
      const usage = completed?.usage;
      const tokens = usage ? `, ${usage.input_tokens ?? "?"} in / ${usage.output_tokens ?? "?"} out` : "";
      log.debug(`codex ${label} answered in ${Date.now() - started}ms${tokens}`);
      return parseOutput(output, req, label);
    },
  };
}

// Only the fields read below; codex prints more events (items, reasoning, ...) and more fields.
const EventSchema = z.looseObject({
  type: z.string(),
  message: z.string().nullish(),
  error: z.looseObject({ message: z.string().nullish() }).nullish(),
  usage: z.looseObject({ input_tokens: z.number().nullish(), output_tokens: z.number().nullish() }).nullish(),
});
type Event = z.output<typeof EventSchema>;

// One event per line; lines that are not events (a notice, a log line) are skipped.
function readEvents(stdout: string): Event[] {
  const events: Event[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = EventSchema.safeParse(value);
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

function noAnswer(exit: Exit, label: string): LlmError {
  if (exit.code !== 0) {
    const how = exit.code === null ? `signal ${exit.signal}` : `code ${exit.code}`;
    return new LlmError("transport", `codex exited with ${how} (${label})`);
  }
  return new LlmError("invalid_output", `codex wrote no final message (${label})`);
}

// The final message should be the JSON itself; text around it is tolerated.
function parseOutput<T>(output: string, req: GenerateRequest<T>, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    value = findFirstJsonObject(output);
  }
  if (value === undefined) throw new LlmError("invalid_output", `codex returned no structured output (${label})`);
  return validateReply(value, req.schema, label);
}

const NOT_LOGGED_IN = /not logged in|codex login|unauthorized|invalid api key/i;
const USAGE_LIMIT = /usage limit|rate limit|too many requests|quota/i;
const CONTEXT_WINDOW = /context window|context_length_exceeded/i;
const UNKNOWN_MODEL = /model\b.*\b(not found|does not exist|not supported|unknown)/i;
const STATUS = /\bstatus:?\s*(\d{3})\b/i;

/**
 * codex reports errors as text only, so the kind is matched from it. The text is never quoted: it
 * can carry the request.
 */
function errorFromEvent(event: Event, label: string): LlmError {
  const text = event.error?.message ?? event.message ?? "";
  if (PROMPT_TOO_LONG.test(text) || CONTEXT_WINDOW.test(text)) {
    return new LlmError("too_large", `the request is too large for codex (${label})`);
  }
  if (NOT_LOGGED_IN.test(text)) {
    return new LlmError("auth", `codex is not logged in or its credentials were rejected; run codex login (${label})`);
  }
  if (USAGE_LIMIT.test(text)) return new LlmError("rate_limit", `codex usage limit reached (${label})`);
  if (UNKNOWN_MODEL.test(text)) return new LlmError("unavailable", `codex does not know the model (${label})`);
  const status = STATUS.exec(text)?.[1];
  if (status) {
    const kind = statusKind(Number(status));
    return new LlmError(kind, `codex request failed (HTTP ${status}, ${label})`);
  }
  // Disconnects and the like; not known to be permanent, so they are retried.
  return new LlmError("transport", `codex reported an error: ${event.type} (${label})`);
}
