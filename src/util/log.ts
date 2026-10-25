const PATTERNS: readonly [RegExp, string][] = [
  [/https:\/\/hooks\.slack\.com\/[^\s"'<>]+/g, "https://hooks.slack.com/***"],
  [/tvly-[\w-]+/g, "tvly-***"],
  [/sk-ant-[\w-]+/g, "sk-ant-***"],
];

// Fallback for secrets whose format the patterns above do not know.
const SECRET_ENV = ["SLACK_WEBHOOK_URL", "TAVILY_API_KEY", "ANTHROPIC_API_KEY"] as const;
const MIN_SECRET_LENGTH = 8;

export function redact(s: string): string {
  let out = s;
  for (const name of SECRET_ENV) {
    const value = process.env[name]?.trim();
    if (value && value.length >= MIN_SECRET_LENGTH) out = out.replaceAll(value, "***");
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export type LogLevel = "quiet" | "normal" | "verbose";
type Severity = "debug" | "info" | "warn" | "error";

const RANK: Record<Severity, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESHOLD: Record<LogLevel, number> = { verbose: 0, normal: 1, quiet: 2 };

// stdout is reserved for --dry-run and --json output, so logs always go to stderr.
const defaultWrite = (s: string) => {
  process.stderr.write(s);
};

let threshold = THRESHOLD.normal;
let write: (s: string) => void = defaultWrite;

export function configureLog(opts: { level?: LogLevel; write?: (s: string) => void }): void {
  threshold = THRESHOLD[opts.level ?? "normal"];
  write = opts.write ?? defaultWrite;
}

function emit(severity: Severity, message: string, err?: unknown): void {
  if (RANK[severity] < threshold) return;
  const detail = err === undefined ? "" : `: ${err instanceof Error ? err.message : String(err)}`;
  write(`${redact(`pochi: ${severity}: ${message}${detail}`)}\n`);
}

export const log = {
  debug: (message: string, err?: unknown) => emit("debug", message, err),
  info: (message: string, err?: unknown) => emit("info", message, err),
  warn: (message: string, err?: unknown) => emit("warn", message, err),
  error: (message: string, err?: unknown) => emit("error", message, err),
};
