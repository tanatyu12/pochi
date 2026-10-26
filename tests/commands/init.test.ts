import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InitDeps, askSources, gitCheckIgnored, runInit, shellQuote, sourceIdFrom } from "../../src/commands/init.js";
import { ConfigError, loadConfig } from "../../src/config/load.js";
import { ExitCode } from "../../src/errors.js";
import { PromptCancelled } from "../../src/util/prompter.js";
import { type Answer, CANCEL, scriptedPrompter } from "../helpers/scriptedPrompter.js";

// name, description, problems (ended by ""), exclude (ended by ""), language.
const CONTEXT_ANSWERS: Answer[] = [
  "my-app",
  "A SaaS app: Next.js\nand Postgres",
  "Next.js breaking changes",
  "日本語の課題",
  "",
  "Funding news",
  "",
  "Japanese",
];
const SOURCE_ANSWERS: Answer[] = [
  "github",
  "vercel/next.js",
  "rss",
  "https://simonwillison.net/atom/everything/",
  "done",
];

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

let dir: string;
let previousUmask: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pochi-init-"));
  previousUmask = process.umask(0o022);
});

afterEach(async () => {
  process.umask(previousUmask);
  await rm(dir, { recursive: true, force: true });
});

function deps(answers: Answer[], overrides: Partial<InitDeps> = {}) {
  const prompter = scriptedPrompter(answers);
  return {
    prompter,
    deps: { prompter, isInteractive: () => true, checkIgnored: async (paths: string[]) => paths.map(() => true), env: {}, ...overrides },
  };
}

describe("runInit", () => {
  it("writes a config that loads back to the answers, readable by the owner only", async () => {
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS]);
    await runInit({ configDir: dir }, d);
    expect(prompter.remaining).toEqual([]);

    const loaded = await loadConfig({ configDir: dir, env: {} });
    expect(loaded.context).toMatchObject({
      project: { name: "my-app", description: "A SaaS app: Next.js\nand Postgres" },
      problems: ["Next.js breaking changes", "日本語の課題"],
      exclude: ["Funding news"],
      language: "Japanese",
    });
    expect(loaded.sources.feeds).toEqual([
      { id: "next-js", type: "github", name: "vercel/next.js", repo: "vercel/next.js", feed: "releases", includePrereleases: false },
      { id: "simonwillison-net", type: "rss", name: "simonwillison.net", url: "https://simonwillison.net/atom/everything/" },
    ]);
    for (const file of ["context.yml", "sources.yml"]) {
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
    }
    expect(prompter.shown.at(-1)).toBe(`outro: Wrote ${join(dir, "context.yml")} and ${join(dir, "sources.yml")}`);
  });

  it("fails with 2 before asking anything when not on a terminal", async () => {
    const { prompter, deps: d } = deps([], { isInteractive: () => false });
    const err = await rejection(runInit({ configDir: dir }, d));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).exitCode).toBe(ExitCode.CONFIG);
    expect(prompter.asked).toEqual([]);
    expect(prompter.shown).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  const answers = [...CONTEXT_ANSWERS, ...SOURCE_ANSWERS];
  it.each([
    ["the project name", 0],
    ["a problem in the middle of the list", 3],
    ["the language", 7],
    ["the first source", 8],
    ["the last source", answers.length - 1],
  ])("exits with 130 and writes nothing when cancelled at %s", async (_, at) => {
    const { deps: d } = deps([...answers.slice(0, at), CANCEL]);
    const err = await rejection(runInit({ configDir: dir }, d));
    expect(err).toBeInstanceOf(PromptCancelled);
    expect((err as PromptCancelled).exitCode).toBe(ExitCode.INTERRUPTED);
    expect(await readdir(dir)).toEqual([]);
  });

  it("asks before overwriting and leaves the files alone when refused", async () => {
    await writeFile(join(dir, "sources.yml"), "# hand-edited\n");
    const { prompter, deps: d } = deps([false]);
    expect(await rejection(runInit({ configDir: dir }, d))).toBeInstanceOf(PromptCancelled);
    expect(prompter.asked).toEqual([`Overwrite ${join(dir, "sources.yml")}?`]);
    expect(await readFile(join(dir, "sources.yml"), "utf8")).toBe("# hand-edited\n");
    expect(await readdir(dir)).toEqual(["sources.yml"]);
  });

  it("leaves existing files alone when cancelled after agreeing to overwrite", async () => {
    await writeFile(join(dir, "context.yml"), "# old\n");
    const { deps: d } = deps([true, ...CONTEXT_ANSWERS, CANCEL]);
    expect(await rejection(runInit({ configDir: dir }, d))).toBeInstanceOf(PromptCancelled);
    expect(await readFile(join(dir, "context.yml"), "utf8")).toBe("# old\n");
  });

  it("overwrites existing files when agreed", async () => {
    await writeFile(join(dir, "context.yml"), "# old\n");
    await writeFile(join(dir, "sources.yml"), "# old\n");
    const { deps: d } = deps([true, ...CONTEXT_ANSWERS, ...SOURCE_ANSWERS]);
    await runInit({ configDir: dir }, d);
    expect((await loadConfig({ configDir: dir, env: {} })).context.project.name).toBe("my-app");
  });

  it("asks for another language when Other is chosen and leaves exclude out when empty", async () => {
    const { deps: d } = deps(["app", "", "Problem", "", "", "other", "German", ...SOURCE_ANSWERS]);
    await runInit({ configDir: dir }, d);
    const text = await readFile(join(dir, "context.yml"), "utf8");
    expect(text).not.toContain("exclude");
    expect((await loadConfig({ configDir: dir, env: {} })).context.language).toBe("German");
  });

  it("requires a project name and at least one problem", async () => {
    expect(await rejection(runInit({ configDir: dir }, deps(["  "]).deps))).toMatchObject({
      message: expect.stringMatching(/rejected .* Required/),
    });
    expect(await rejection(runInit({ configDir: dir }, deps(["app", "", ""]).deps))).toMatchObject({
      message: expect.stringMatching(/rejected .* Required/),
    });
  });

  it("stops asking for problems at 20", async () => {
    const problems = Array.from({ length: 20 }, (_, i) => `Problem ${i + 1}`);
    const { prompter, deps: d } = deps(["app", "", ...problems, "", "English", ...SOURCE_ANSWERS]);
    await runInit({ configDir: dir }, d);
    expect(prompter.asked.filter((m) => m.startsWith("What do you want to hear about?"))).toHaveLength(20);
    expect((await loadConfig({ configDir: dir, env: {} })).context.problems).toEqual(problems);
  });

  it("warns when git does not ignore the files and notes when it cannot tell", async () => {
    const checked: string[][] = [];
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS], {
      checkIgnored: async (paths) => {
        checked.push(paths);
        return [false, undefined];
      },
    });
    await runInit({ configDir: dir }, d);
    expect(checked).toEqual([[join(dir, "context.yml"), join(dir, "sources.yml")]]);
    expect(prompter.shown).toContain(
      `warn: ${join(dir, "context.yml")} is not ignored by git; add ${join(dir, "*.yml")} to .gitignore before committing.`,
    );
    expect(prompter.shown).toContain(`note: Could not check whether git ignores ${join(dir, "sources.yml")}.`);
  });

  it("checks with git by default", async () => {
    // The temporary directory is in no repository, so git cannot tell.
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS]);
    const { checkIgnored: _, ...withoutCheck } = d;
    await runInit({ configDir: dir }, withoutCheck);
    expect(prompter.shown).toContain(`note: Could not check whether git ignores ${join(dir, "context.yml")}.`);
  });

  it("points the next steps at the config dir used, quoted for the shell", async () => {
    const spaced = join(dir, "my configs");
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS]);
    await runInit({ configDir: spaced }, d);
    const steps = prompter.shown.find((s) => s.startsWith("note: Next steps: "))!;
    expect(steps).toContain(`run --dry-run --config-dir '${spaced}'`);
    expect(steps).toContain(`gh secret set POCHI_CONTEXT_YAML < '${join(spaced, "context.yml")}'`);
  });

  it("leaves --config-dir out of the next steps for the default dir", async () => {
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS]);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await runInit({}, d);
    } finally {
      process.chdir(cwd);
    }
    expect(prompter.shown).toContain(
      [
        "note: Next steps: node dist/pochi.mjs run --dry-run",
        "gh secret set POCHI_CONTEXT_YAML < config/context.yml",
        "gh secret set POCHI_SOURCES_YAML < config/sources.yml",
        "gh secret set SLACK_WEBHOOK_URL",
        "gh secret set ANTHROPIC_API_KEY",
      ].join("\n"),
    );
  });

  it("warns when the env vars would override the files, without showing their values", async () => {
    const secret = "project: { name: leaked-value }";
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS], {
      env: { POCHI_CONTEXT_YAML: secret, POCHI_SOURCES_YAML: "  ", SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" },
    });
    await runInit({ configDir: dir }, d);
    expect(prompter.shown).toContain("warn: POCHI_CONTEXT_YAML is set and takes precedence over the files just written.");
    expect(prompter.shown.join("\n")).not.toContain("POCHI_SOURCES_YAML is set");
    expect(prompter.shown.join("\n")).not.toContain("leaked-value");
    expect(prompter.shown.join("\n")).not.toContain("hooks.slack.com");
  });
});

describe("askSources", () => {
  it("does not offer Done until a source is added", async () => {
    const prompter = scriptedPrompter(["done"]);
    expect(await rejection(askSources(prompter))).toMatchObject({ message: expect.stringMatching(/not an option/) });
  });

  it("rejects malformed repos and URLs", async () => {
    for (const repo of ["next.js", "vercel/next.js/x", "a/..", "own.er/repo"]) {
      expect(await rejection(askSources(scriptedPrompter(["github", repo])))).toMatchObject({
        message: expect.stringMatching(/owner\/repo/),
      });
    }
    for (const url of ["simonwillison.net", "ftp://example.com/feed", "/feed.xml"]) {
      expect(await rejection(askSources(scriptedPrompter(["rss", url])))).toMatchObject({
        message: expect.stringMatching(/http\(s\) URL/),
      });
    }
  });

  it("goes back to the choice of source on an empty repo or URL", async () => {
    const prompter = scriptedPrompter(["github", "  ", "rss", "", "github", "vercel/next.js", "done"]);
    const sources = await askSources(prompter);
    expect(sources.feeds!.map((f) => f.id)).toEqual(["next-js"]);
    expect(prompter.remaining).toEqual([]);
  });

  it("treats feed URLs that normalize the same as one feed", async () => {
    const prompter = scriptedPrompter([
      "rss",
      "https://example.com/feed",
      "rss",
      "https://example.com/feed/?utm_source=x#top",
      "done",
    ]);
    const sources = await askSources(prompter);
    expect(sources.feeds).toEqual([{ id: "example-com", type: "rss", name: "example.com", url: "https://example.com/feed" }]);
    expect(prompter.shown).toEqual(["warn: Already added; skipped."]);
  });

  it("gives clashing names distinct ids and skips sources already added", async () => {
    const prompter = scriptedPrompter([
      "github",
      " vercel/next.js ",
      "github",
      "Vercel/Next.js",
      "github",
      "someone/next.js",
      "rss",
      "https://www.example.com/feed",
      "rss",
      "https://example.com/feed",
      "done",
    ]);
    const sources = await askSources(prompter);
    expect(sources.feeds!.map((f) => f.id)).toEqual(["next-js", "next-js-2", "example-com", "example-com-2"]);
    expect(prompter.shown).toEqual(["warn: Already added; skipped."]);
  });
});

describe("sourceIdFrom", () => {
  it.each([
    ["next.js", "next-js"],
    [".github", "github"],
    ["My_Repo", "my_repo"],
    ["日本語", "source"],
    ["a--", "a"],
  ])("%s -> %s", (raw, id) => {
    expect(sourceIdFrom(raw, new Set())).toBe(id);
  });

  it("appends a number until the id is free", () => {
    expect(sourceIdFrom("blog", new Set(["blog", "blog-2"]))).toBe("blog-3");
  });
});

describe("shellQuote", () => {
  it.each([
    ["config/context.yml", "config/context.yml"],
    ["/tmp/my configs", "'/tmp/my configs'"],
    ["it's", "'it'\\''s'"],
    ["$HOME", "'$HOME'"],
  ])("%s -> %s", (raw, quoted) => {
    expect(shellQuote(raw)).toBe(quoted);
  });
});

describe("gitCheckIgnored", () => {
  it("tells ignored, not ignored and unknown paths apart in one call", async () => {
    // Relative to the repository this test runs in, whose .gitignore covers config/*.yml.
    expect(await gitCheckIgnored(["config/context.yml", "config/context.example.yml"])).toEqual([true, false]);
    expect(await gitCheckIgnored(["config/context.example.yml", "config/sources.example.yml"])).toEqual([false, false]);
    expect(await gitCheckIgnored([join(dir, "context.yml"), join(dir, "sources.yml")])).toEqual([undefined, undefined]);
  });
});
