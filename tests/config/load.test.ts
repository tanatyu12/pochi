import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseContext, parseSources } from "../../src/config/load.js";

const EXAMPLE_DIR = new URL("../../config/", import.meta.url);
const CONTEXT = "version: 1\nproject: { name: app, description: '' }\nproblems: [p]\n";
const SOURCES = "version: 1\nqueries: [{ id: q, query: x }]\n";
const SECRETS = ["sk-ant-api03-SECRET123", "https://hooks.slack.com/services/T0/B0/SECRET", "tvly-SECRET456"];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pochi-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfigFiles(context: string, sources: string): Promise<void> {
  await writeFile(join(dir, "context.yml"), context);
  await writeFile(join(dir, "sources.yml"), sources);
}

async function loadError(opts: Parameters<typeof loadConfig>[0]): Promise<ConfigError> {
  const err = await loadConfig(opts).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as ConfigError).exitCode).toBe(2);
  return err as ConfigError;
}

describe("loadConfig", () => {
  it("accepts the example files", async () => {
    const [context, sources] = await Promise.all([
      readFile(new URL("context.example.yml", EXAMPLE_DIR), "utf8"),
      readFile(new URL("sources.example.yml", EXAMPLE_DIR), "utf8"),
    ]);
    await writeConfigFiles(context, sources);
    const loaded = await loadConfig({ configDir: dir, env: {} });
    expect(loaded.context.project.name).toBe("my-app");
    expect(loaded.sources.feeds.map((f) => f.type)).toEqual(["github", "rss"]);
    expect(loaded.sources.queries).toHaveLength(1);
  });

  it("reads config/*.yml with file origins", async () => {
    await writeConfigFiles(CONTEXT, SOURCES);
    const loaded = await loadConfig({ configDir: dir, env: {} });
    expect(loaded.origins).toEqual({
      context: { kind: "file", path: join(dir, "context.yml") },
      sources: { kind: "file", path: join(dir, "sources.yml") },
    });
  });

  it("prefers environment variables over files, per file", async () => {
    await writeConfigFiles(CONTEXT, SOURCES);
    const env = { POCHI_CONTEXT_YAML: CONTEXT.replace("name: app", "name: from-env") };
    const loaded = await loadConfig({ configDir: dir, env });
    expect(loaded.context.project.name).toBe("from-env");
    expect(loaded.origins.context).toEqual({ kind: "env", name: "POCHI_CONTEXT_YAML" });
    expect(loaded.origins.sources).toEqual({ kind: "file", path: join(dir, "sources.yml") });
  });

  it("needs no files when both variables are set", async () => {
    const loaded = await loadConfig({
      configDir: join(dir, "missing"),
      env: { POCHI_CONTEXT_YAML: CONTEXT, POCHI_SOURCES_YAML: SOURCES },
    });
    expect(loaded.origins.sources).toEqual({ kind: "env", name: "POCHI_SOURCES_YAML" });
  });

  it("treats a blank variable as unset", async () => {
    await writeConfigFiles(CONTEXT, SOURCES);
    const loaded = await loadConfig({ configDir: dir, env: { POCHI_CONTEXT_YAML: " \n" } });
    expect(loaded.origins.context.kind).toBe("file");
  });

  it("reports missing files with a hint", async () => {
    const err = await loadError({ configDir: dir, env: {} });
    expect(err.message).toContain(`${join(dir, "context.yml")} not found (run "pochi init" or set POCHI_CONTEXT_YAML)`);
    expect(err.message).toContain("POCHI_SOURCES_YAML");
  });

  it("reports errors from both files in one message", async () => {
    await writeConfigFiles("version: 1\n", "version: 1\n");
    const err = await loadError({ configDir: dir, env: {} });
    expect(err.message.split("\n")).toEqual([
      `${join(dir, "context.yml")}: project: expected object`,
      `${join(dir, "context.yml")}: problems: expected array`,
      `${join(dir, "sources.yml")}: (root): at least one feed or query is required`,
    ]);
  });

  it("labels errors from environment variables with the variable name", async () => {
    const err = await loadError({ configDir: dir, env: { POCHI_CONTEXT_YAML: "version: 1\n", POCHI_SOURCES_YAML: SOURCES } });
    expect(err.message).toMatch(/^POCHI_CONTEXT_YAML: project: expected object/);
  });

  it("rejects duplicate keys", async () => {
    await writeConfigFiles(`${CONTEXT}language: English\nlanguage: Japanese\n`, SOURCES);
    const err = await loadError({ configDir: dir, env: {} });
    expect(err.message).toBe(`${join(dir, "context.yml")}: invalid YAML at line 5, column 1 (DUPLICATE_KEY)`);
  });

  it("rejects an alias bomb", async () => {
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 8; i++) lines.push(`${"abcdefgh"[i]}: &${"abcdefgh"[i]} [${Array(10).fill(`*${"abcdefgh"[i - 1]}`).join(", ")}]`);
    await writeConfigFiles(`${CONTEXT}${lines.join("\n")}\n`, SOURCES);
    const err = await loadError({ configDir: dir, env: {} });
    expect(err.message).toBe(`${join(dir, "context.yml")}: invalid YAML (too many aliases)`);
  });

  describe("never echoes values", () => {
    it.each(SECRETS)("keeps %s out of schema errors", async (secret) => {
      const context = [
        `version: "${secret}"`,
        `project: { name: app, description: '', "${secret}": 1 }`,
        "problems: [p]",
        `llm: { provider: "${secret}", maxItemsPerCall: "${secret}" }`,
        `"${secret}": x`,
      ].join("\n");
      const sources = `version: 1\nfeeds: [{ id: "${secret}", type: rss, name: x, url: "ftp:${secret}" }]\n`;
      await writeConfigFiles(context, sources);
      const err = await loadError({ configDir: dir, env: {} });
      expect(err.message).not.toContain("SECRET");
      expect(err.message).toContain("llm.provider: invalid option");
      expect(err.message).toContain("project: unknown key");
      expect(err.message).toContain("feeds[0].url: must be an absolute http(s) URL");
    });

    it.each(SECRETS)("keeps %s out of YAML syntax errors", async (secret) => {
      await writeConfigFiles(`${CONTEXT}language: [${secret}\n`, SOURCES);
      const err = await loadError({ configDir: dir, env: {} });
      expect(err.message).toMatch(/invalid YAML at line \d+, column \d+ \(\w+\)/);
      expect(err.message).not.toContain("SECRET");
    });
  });
});

describe("parseContext / parseSources", () => {
  it("parses text and throws ConfigError with the label", () => {
    expect(parseContext(CONTEXT, "ctx").project.name).toBe("app");
    expect(parseSources(SOURCES, "src").queries[0]?.id).toBe("q");
    expect(() => parseSources("version: 1\n", "src")).toThrow(/^src: \(root\): at least one/);
  });
});
