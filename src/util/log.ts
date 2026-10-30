import { styleText } from "node:util";
import { isFancy, purple } from "./pochiArt.js";
import { stripControlChars } from "./text.js";

const PATTERNS: readonly [RegExp, string][] = [
  [/https:\/\/hooks\.slack\.com\/[^\s"'<>]+/g, "https://hooks.slack.com/***"],
  [/tvly-[\w-]+/g, "tvly-***"],
  [/sk-ant-[\w-]+/g, "sk-ant-***"],
  // OpenAI project, service-account and admin keys, then legacy ones. The length floor keeps
  // words such as "sk-key" readable.
  [/\bsk-(proj|svcacct|admin)-[\w-]+/g, "sk-$1-***"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "sk-***"],
  [/\b(gh[pousr]_|github_pat_)\w+/g, "$1***"],
];

// Fallback for secrets whose format the patterns above do not know.
// The LLM tokens matter too: claude's and codex's stderr is logged with --verbose.
// Also the one list of secret names that doctor and the generated workflow name theirs from.
export const SECRET_ENV = [
  "SLACK_WEBHOOK_URL",
  "TAVILY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GITHUB_TOKEN",
] as const;
export type SecretEnvName = (typeof SECRET_ENV)[number];
const MIN_SECRET_LENGTH = 8;

// Values a host passes in through deps.env rather than process.env.
let extraSecrets: readonly string[] = [];

export function redact(s: string): string {
  let out = s;
  const values = [...SECRET_ENV.map((name) => process.env[name]), ...extraSecrets];
  for (const raw of values) {
    const value = raw?.trim();
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    // URLs carry the secret percent-encoded (e.g. a key with "+" or "/" in a query string).
    out = out.replaceAll(value, "***").replaceAll(encodeURIComponent(value), "***");
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export type LogLevel = "quiet" | "normal" | "verbose";
type Severity = "debug" | "info" | "warn" | "error";

const RANK: Record<Severity, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESHOLD: Record<LogLevel, number> = { verbose: 0, normal: 1, quiet: 2 };

// stdout carries the commands' own output (a briefing, JSON, a report), so logs always go to stderr.
const defaultWrite = (s: string) => {
  process.stderr.write(s);
};

let threshold = THRESHOLD.normal;
let write: (s: string) => void = defaultWrite;

// Fields left out keep their current value. Returns a function that puts back the previous settings.
// `secrets` are masked like the values of SECRET_ENV, for a host whose env is not process.env.
export function configureLog(opts: {
  level?: LogLevel;
  write?: (s: string) => void;
  secrets?: readonly string[];
}): () => void {
  const previous = { threshold, write, extraSecrets };
  if (opts.level) threshold = THRESHOLD[opts.level];
  if (opts.write) write = opts.write;
  if (opts.secrets) extraSecrets = [...opts.secrets];
  return () => {
    threshold = previous.threshold;
    write = previous.write;
    extraSecrets = previous.extraSecrets;
  };
}

export function resetLog(): void {
  threshold = THRESHOLD.normal;
  write = defaultWrite;
  extraSecrets = [];
}

// On a terminal a person reads, the severity is a mark rather than a word.
const MARKS: Record<Severity, (text: string) => string> = {
  debug: (text) => styleText("dim", `  · ${text}`),
  info: (text) => `  ${purple("›")} ${text}`,
  warn: (text) => `  ${styleText("yellow", "!")} ${text}`,
  error: (text) => `  ${styleText("red", "×")} ${text}`,
};

function emit(severity: Severity, message: string, err?: unknown): void {
  if (RANK[severity] < threshold) return;
  const detail = err === undefined ? "" : `: ${err instanceof Error ? err.message : String(err)}`;
  // Messages carry feed text and model output (triage reasons, claude's stderr): no escape
  // sequence in them may reach the terminal.
  const text = stripControlChars(redact(`${message}${detail}`));
  // Only on the real stderr: a write passed in (a test, init's spinner) gets the plain line.
  const fancy = write === defaultWrite && isFancy(process.stderr);
  write(`${fancy ? MARKS[severity](text) : `pochi: ${severity}: ${text}`}\n`);
}

export const log = {
  debug: (message: string, err?: unknown) => emit("debug", message, err),
  info: (message: string, err?: unknown) => emit("info", message, err),
  warn: (message: string, err?: unknown) => emit("warn", message, err),
  error: (message: string, err?: unknown) => emit("error", message, err),
};
