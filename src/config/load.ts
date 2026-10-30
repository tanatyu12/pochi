import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { z } from "zod";
import { ExitCode, PochiError } from "../errors.js";
import { type Context, ContextSchema, type Sources, SourcesSchema, formatIssues } from "./schema.js";

export const DEFAULT_CONFIG_DIR = "config";
// Enough for anchors used as shorthand; far below what an alias bomb needs.
const MAX_ALIAS_COUNT = 50;

export type ConfigOrigin = { kind: "env"; name: string } | { kind: "file"; path: string };

export interface LoadedConfig {
  context: Context;
  sources: Sources;
  origins: { context: ConfigOrigin; sources: ConfigOrigin };
}

export class ConfigError extends PochiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, ExitCode.CONFIG, options);
  }
}

const FILES = {
  context: { file: "context.yml", env: "POCHI_CONTEXT_YAML" },
  sources: { file: "sources.yml", env: "POCHI_SOURCES_YAML" },
} as const;

/** The env vars that, when set and not blank, replace the config files. */
export const CONFIG_ENV_NAMES = [FILES.context.env, FILES.sources.env] as const;

/** Which of CONFIG_ENV_NAMES loadConfig would read instead of the files. */
export function configEnvOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  return CONFIG_ENV_NAMES.filter((name) => isSet(env[name]));
}

// Actions expands an unset secret to "", so blank counts as unset.
function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

export async function loadConfig(
  opts: { configDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LoadedConfig> {
  const dir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const env = opts.env ?? process.env;
  const [context, sources] = await Promise.all([
    load("context", dir, env, ContextSchema),
    load("sources", dir, env, SourcesSchema),
  ]);
  // Report both files at once so a broken setup is fixed in one pass.
  const errors = [context, sources].flatMap((r) => (r.ok ? [] : [r.message]));
  if (!context.ok || !sources.ok) throw new ConfigError(errors.join("\n"));
  return {
    context: context.value,
    sources: sources.value,
    origins: { context: context.origin, sources: sources.origin },
  };
}

export function parseContext(text: string, label: string): Context {
  return unwrap(parseYaml(text, label, ContextSchema));
}

export function parseSources(text: string, label: string): Sources {
  return unwrap(parseYaml(text, label, SourcesSchema));
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

async function load<T>(
  key: keyof typeof FILES,
  dir: string,
  env: NodeJS.ProcessEnv,
  schema: z.ZodType<T>,
): Promise<Parsed<T> & { origin: ConfigOrigin }> {
  const { file, env: name } = FILES[key];
  const fromEnv = env[name];
  if (isSet(fromEnv)) {
    return { ...parseYaml(fromEnv, name, schema), origin: { kind: "env", name } };
  }
  const path = join(dir, file);
  const origin: ConfigOrigin = { kind: "file", path };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, message: `${path} not found (run "pochi init" or set ${name})`, origin };
    }
    throw new ConfigError(`cannot read ${path}`, { cause: err });
  }
  return { ...parseYaml(text, path, schema), origin };
}

function parseYaml<T>(text: string, label: string, schema: z.ZodType<T>): Parsed<T> {
  const doc = parseDocument(text, { uniqueKeys: true });
  // yaml's error messages quote the offending source line, so only the position and code are kept.
  const yamlErrors = doc.errors.map((e) => {
    const pos = e.linePos?.[0];
    return `${label}: invalid YAML${pos ? ` at line ${pos.line}, column ${pos.col}` : ""} (${e.code})`;
  });
  if (yamlErrors.length > 0) return { ok: false, message: yamlErrors.join("\n") };

  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch {
    return { ok: false, message: `${label}: invalid YAML (too many aliases)` };
  }
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, message: formatIssues(result.error.issues, label).join("\n") };
}

function unwrap<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new ConfigError(parsed.message);
  return parsed.value;
}
