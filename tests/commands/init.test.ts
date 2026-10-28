import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InitDeps,
  askSources,
  gitCheckIgnored,
  newSession,
  queryIdFrom,
  runInit,
  shellQuote,
  sourceIdFrom,
} from "../../src/commands/init.js";
import { ConfigError, loadConfig } from "../../src/config/load.js";
import { ContextSchema } from "../../src/config/schema.js";
import { ExitCode } from "../../src/errors.js";
import type { resolveLlm } from "../../src/llm/adapter.js";
import {
  type GenerateRequest,
  IdeaSuggestionOutputSchema,
  type IdeaSuggestionOutput,
  type LlmClient,
  LlmError,
  QuerySuggestionOutputSchema,
  RepoInferenceOutputSchema,
} from "../../src/llm/schema.js";
import { PromptCancelled } from "../../src/util/prompter.js";
import { type Route, mockFetch, reply } from "../helpers/mockFetch.js";
import { type Answer, CANCEL, scriptedPrompter } from "../helpers/scriptedPrompter.js";

const FIXTURES = join(import.meta.dirname, "../fixtures/feeds");
const API = "https://api.github.com/repos";
const SIMON = "https://simonwillison.net/atom/everything/";
const TAVILY = "https://api.tavily.com/search";

// name, description, problems (ended by ""), exclude (ended by ""), language, channels, no ideas.
const CONTEXT_ANSWERS: Answer[] = [
  "my-app",
  "A SaaS app: Next.js\nand Postgres",
  "Next.js breaking changes",
  "日本語の課題",
  "",
  "Funding news",
  "",
  "Japanese",
  ["slack"],
  false,
];
// Two sources, then yes to watching each after the trial fetch.
const SOURCE_ANSWERS: Answer[] = ["repo", "vercel/next.js", "site", SIMON, "done", true, true];

const CONTEXT = ContextSchema.parse({ version: 1, project: { name: "app", description: "" }, problems: ["News"] });

function atom(title: string, link = "https://example.com/post"): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<entry><id>${link}</id><title>${title}</title><link rel="alternate" type="text/html" href="${link}"/>
<updated>2026-10-25T00:00:00Z</updated><content type="html">body</content></entry></feed>`;
}

function release(name: string, prerelease = false) {
  return {
    html_url: `https://github.com/x/y/releases/tag/${name}`,
    tag_name: name,
    name,
    draft: false,
    prerelease,
    published_at: "2026-10-24T00:00:00Z",
    body_html: "<p>notes</p>",
  };
}

/** verifyRepo and the trial fetch of a repository with releases. */
function repoRoutes(repo: string, opts: { fullName?: string; releases?: unknown[] } = {}): Record<string, Route> {
  const current = opts.fullName ?? repo;
  return {
    [`${API}/${repo}`]: reply.json({ full_name: current }),
    [`${API}/${current}/releases?per_page=100`]: reply.json(opts.releases ?? [release("v16.0.0")]),
  };
}

const BASE_ROUTES: Record<string, Route> = {
  ...repoRoutes("vercel/next.js"),
  [SIMON]: reply.text(atom("Simon's post")),
};

/** Answers repo lookups with repos(name), query suggestions with queries() and ideas with ideas(); any may throw. */
function fakeLlm(
  over: {
    repos?: (name: string) => { repo: string; note: string }[];
    queries?: () => string[];
    ideas?: () => IdeaSuggestionOutput["ideas"];
  } = {},
) {
  const calls: string[] = [];
  const client: LlmClient = {
    mode: "api",
    async generate<T>(req: GenerateRequest<T>): Promise<T> {
      const schema: unknown = req.schema;
      if (schema === RepoInferenceOutputSchema) {
        const name = req.prompt.match(/<name id="q1">(.*)<\/name>/)![1]!;
        calls.push(`repo:${name}`);
        return { results: [{ id: "q1", candidates: over.repos?.(name) ?? [] }] } as T;
      }
      if (schema === QuerySuggestionOutputSchema) {
        calls.push("queries");
        return { queries: over.queries?.() ?? [] } as T;
      }
      if (schema === IdeaSuggestionOutputSchema) {
        calls.push("ideas");
        return { ideas: over.ideas?.() ?? [] } as T;
      }
      throw new Error("unexpected request");
    },
  };
  const resolve: typeof resolveLlm = async () => ({ client, models: { triage: "t", analyze: "a" } });
  return { client, calls, resolve };
}

const noLlm: typeof resolveLlm = async () => {
  throw new LlmError("unavailable", "no LLM available");
};

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
  vi.stubEnv("TAVILY_API_KEY", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  mockFetch(BASE_ROUTES);
});

afterEach(async () => {
  process.umask(previousUmask);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function deps(answers: Answer[], overrides: Partial<InitDeps> = {}) {
  const prompter = scriptedPrompter(answers);
  return {
    prompter,
    deps: {
      prompter,
      isInteractive: () => true,
      checkIgnored: async (paths: string[]) => paths.map(() => true),
      env: {},
      resolveLlm: noLlm,
      ...overrides,
    },
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
      { id: "simonwillison-net", type: "rss", name: "simonwillison.net/atom/everything", url: SIMON },
    ]);
    for (const file of ["context.yml", "sources.yml"]) {
      expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
    }
    expect(prompter.shown.at(-1)).toBe(`outro: Wrote ${join(dir, "context.yml")} and ${join(dir, "sources.yml")}`);
  });

  it("completes without an LLM, saying so once", async () => {
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS]);
    await runInit({ configDir: dir }, d);
    expect(prompter.shown.filter((s) => s.includes("Continuing without Claude"))).toEqual([
      "warn: no LLM available. Continuing without Claude: enter repositories as owner/repo.",
    ]);
    expect(prompter.asked).toContain("GitHub repository (empty to go back)");
  });

  it("passes the env and the parsed llm settings to resolveLlm", async () => {
    const llm = fakeLlm();
    const seen: unknown[] = [];
    const { deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS], {
      env: { ANTHROPIC_API_KEY: "k" },
      resolveLlm: async (settings, opts) => {
        seen.push(settings, opts?.env);
        return llm.resolve(settings, opts);
      },
    });
    await runInit({ configDir: dir }, d);
    expect(seen).toEqual([{ provider: "auto", maxItemsPerCall: 40, maxItemsPerRun: 150 }, { ANTHROPIC_API_KEY: "k" }]);
    // Both sources were typed in full, so the model was never asked.
    expect(llm.calls).toEqual([]);
  });

  it("waits for Claude only when a step needs it, and stops the lookup when done", async () => {
    let lookup: AbortSignal | undefined;
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, "site", SIMON, "done", true], {
      // Never settles, like a CLI probe that hangs.
      resolveLlm: (_, opts) => {
        lookup = opts?.signal;
        return new Promise(() => {});
      },
    });
    await runInit({ configDir: dir }, d);
    expect(prompter.shown.some((s) => s.includes("Looking for Claude"))).toBe(false);
    expect(lookup?.aborted).toBe(true);
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
    ["the trial fetch", answers.length - 1],
  ])("exits with 130 and writes nothing when cancelled at %s", async (_, at) => {
    const { deps: d } = deps([...answers.slice(0, at), CANCEL]);
    const err = await rejection(runInit({ configDir: dir }, d));
    expect(err).toBeInstanceOf(PromptCancelled);
    expect((err as PromptCancelled).exitCode).toBe(ExitCode.INTERRUPTED);
    expect(await readdir(dir)).toEqual([]);
  });

  it("exits with 130 and writes nothing when interrupted while fetching", async () => {
    const fetch = mockFetch({ [`${API}/vercel/next.js`]: reply.hang() });
    const controller = new AbortController();
    const { deps: d } = deps([...CONTEXT_ANSWERS, "repo", "vercel/next.js"], { signal: controller.signal });
    const done = rejection(runInit({ configDir: dir }, d));
    await vi.waitFor(() => expect(fetch.calls).toHaveLength(1));
    controller.abort();
    expect(await done).toBeInstanceOf(PromptCancelled);
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
    const { deps: d } = deps(["app", "", "Problem", "", "", "other", "German", ["slack"], false, ...SOURCE_ANSWERS]);
    await runInit({ configDir: dir }, d);
    const text = await readFile(join(dir, "context.yml"), "utf8");
    expect(text).not.toContain("exclude");
    expect((await loadConfig({ configDir: dir, env: {} })).context.language).toBe("German");
  });

  it("asks again until a channel is picked, and leaves the Actions steps out for files only", async () => {
    const { prompter, deps: d } = deps(["app", "", "Problem", "", "", "English", [], ["file"], false, ...SOURCE_ANSWERS]);
    await runInit({ configDir: dir }, d);
    expect(prompter.shown).toContain("warn: Pick at least one.");
    expect((await loadConfig({ configDir: dir, env: {} })).context.notify.channels).toEqual([
      { type: "file", dir: "reports" },
    ]);
    const steps = prompter.shown.find((s) => s.startsWith("note: Next steps: "))!;
    expect(steps).toContain(`node dist/pochi.mjs run --config-dir`);
    expect(steps).not.toContain("gh secret set");
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
    const { prompter, deps: d } = deps(["app", "", ...problems, "", "English", ["slack"], ...SOURCE_ANSWERS]);
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

/** Runs askSources on scripted answers, with the LLM client given (none by default). */
function sources(answers: Answer[], llm?: LlmClient) {
  const prompter = scriptedPrompter(answers);
  return { prompter, result: askSources(newSession(prompter, CONTEXT, { llm })) };
}

describe("askSources: repositories", () => {
  it("does not offer Done until a source is added", async () => {
    const { result } = sources(["done"]);
    expect(await rejection(result)).toMatchObject({ message: expect.stringMatching(/not an option/) });
  });

  it("checks a typed owner/repo on GitHub without asking the model", async () => {
    const llm = fakeLlm();
    const { result } = sources(["repo", "vercel/next.js", "done", true], llm.client);
    expect((await result).feeds).toEqual([{ id: "next-js", type: "github", name: "vercel/next.js", repo: "vercel/next.js" }]);
    expect(llm.calls).toEqual([]);
  });

  it("rejects names that are not owner/repo without an LLM, and malformed repos with one", async () => {
    for (const repo of ["next.js", "vercel/next.js/x", "a/..", "own.er/repo"]) {
      expect(await rejection(sources(["repo", repo]).result)).toMatchObject({ message: expect.stringMatching(/owner\/repo/) });
    }
    for (const repo of ["vercel/next.js/x", "a/.."]) {
      expect(await rejection(sources(["repo", repo], fakeLlm().client).result)).toMatchObject({
        message: expect.stringMatching(/owner\/repo/),
      });
    }
  });

  it("goes back to the choice of source when a repository is missing or has nothing to watch", async () => {
    mockFetch({
      ...BASE_ROUTES,
      [`${API}/ghost/missing`]: reply.status(404),
      ...repoRoutes("acme/empty", { releases: [] }),
      "https://github.com/acme/empty/tags.atom": reply.text(await readFile(join(FIXTURES, "github-empty.atom"), "utf8")),
    });
    const { prompter, result } = sources(["repo", "ghost/missing", "repo", "acme/empty", "repo", "  ", "repo", "vercel/next.js", "done", true]);
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js"]);
    expect(prompter.shown).toContain("warn: ghost/missing was not found on GitHub.");
    expect(prompter.shown).toContain("warn: acme/empty has no releases or tags to watch.");
  });

  it("follows a moved repository and watches tags when it has no releases", async () => {
    const tags = await readFile(join(FIXTURES, "github-tags.atom"), "utf8");
    mockFetch({
      ...repoRoutes("old/widget", { fullName: "acme/widget", releases: [] }),
      "https://github.com/acme/widget/tags.atom": reply.text(tags),
    });
    const { prompter, result } = sources(["repo", "old/widget", "done", true]);
    expect((await result).feeds).toEqual([
      { id: "widget", type: "github", name: "acme/widget", repo: "acme/widget", feed: "tags" },
    ]);
    expect(prompter.shown).toContain("note: old/widget moved to acme/widget; watching that instead.");
    expect(prompter.shown).toContain("note: acme/widget (github): v1.9.0\n2026-10-20\nhttps://github.com/acme/widget/releases/tag/v1.9.0");
  });

  it("follows prereleases when a repository has nothing else", async () => {
    mockFetch(repoRoutes("acme/canary", { releases: [release("v1.0.0-canary.1", true)] }));
    const { prompter, result } = sources(["repo", "acme/canary", "done", true]);
    expect((await result).feeds![0]).toMatchObject({ repo: "acme/canary", includePrereleases: true });
    expect(prompter.shown).toContain("note: acme/canary has only prereleases so far; following them.");
  });

  it("lets the user add a typed repository GitHub could not check", async () => {
    mockFetch({ [`${API}/acme/private`]: reply.status(403) });
    const { prompter, result } = sources(["repo", "acme/private", true, "done", true]);
    expect((await result).feeds).toEqual([{ id: "private", type: "github", name: "acme/private", repo: "acme/private" }]);
    expect(prompter.asked).toContain("Add acme/private anyway?");
    expect(prompter.shown.some((s) => s.startsWith("warn: acme/private (github) failed: "))).toBe(true);
  });

  it("offers only the candidates GitHub confirms, at most three", async () => {
    const fetch = mockFetch({
      ...BASE_ROUTES,
      [`${API}/ghost/missing`]: reply.status(404),
      [`${API}/acme/forbidden`]: reply.status(403),
    });
    const llm = fakeLlm({
      repos: () => [
        { repo: "not a repo", note: "" },
        { repo: " vercel/next.js ", note: "The framework\n\u001b[31mred\u001b[0m" },
        { repo: "Vercel/Next.js", note: "dup" },
        { repo: "ghost/missing", note: "" },
        { repo: "acme/forbidden", note: "" },
        { repo: "acme/fourth", note: "" },
      ],
    });
    const { prompter, result } = sources(["repo", "Next.js", "vercel/next.js", "done", true], llm.client);
    expect((await result).feeds!.map((f) => (f.type === "github" ? f.repo : f.url))).toEqual(["vercel/next.js"]);
    expect(llm.calls).toEqual(["repo:Next.js"]);
    expect(prompter.options["Which repository is Next.js?"]).toEqual(["vercel/next.js", "none"]);
    expect(prompter.shown).toContain("warn: Could not check 1 candidate on GitHub; left out.");
    expect(fetch.calls.map((c) => c.url)).not.toContain(`${API}/acme/fourth`);
  });

  it("goes back when no candidate exists or none is chosen", async () => {
    mockFetch({ ...BASE_ROUTES, [`${API}/ghost/missing`]: reply.status(404) });
    const llm = fakeLlm({ repos: (name) => (name === "Ghost" ? [{ repo: "ghost/missing", note: "" }] : [{ repo: "vercel/next.js", note: "" }]) });
    const { prompter, result } = sources(
      ["repo", "Ghost", "repo", "Next.js", "none", "repo", "vercel/next.js", "done", true],
      llm.client,
    );
    expect((await result).feeds!.map((f) => (f.type === "github" ? f.repo : f.url))).toEqual(["vercel/next.js"]);
    expect(prompter.shown).toContain("warn: No GitHub repository found for Ghost; enter it as owner/repo.");
  });

  it("stops asking the model after an auth error, but keeps it after a transient one", async () => {
    const kinds = ["transport", "auth"] as const;
    const llm = fakeLlm({
      repos: () => {
        throw new LlmError(kinds[llm.calls.length - 1]!, "failed");
      },
    });
    const first = sources(["repo", "Next.js", "repo", "Next.js", "repo", "vercel/next.js", "done", true], llm.client);
    await first.result;
    expect(llm.calls).toEqual(["repo:Next.js", "repo:Next.js"]);
    expect(first.prompter.shown).toContain("warn: Claude could not answer (transport).");
    expect(first.prompter.shown).toContain("warn: Claude is not usable (auth); continuing without it.");
    expect(first.prompter.asked.at(-3)).toBe("GitHub repository (empty to go back)");
  });

  it("gives clashing names distinct ids and skips sources already added", async () => {
    mockFetch({
      ...repoRoutes("vercel/next.js"),
      [`${API}/Vercel/Next.js`]: reply.json({ full_name: "vercel/next.js" }),
      ...repoRoutes("someone/next.js"),
    });
    const { prompter, result } = sources([
      "repo",
      " vercel/next.js ",
      "repo",
      "Vercel/Next.js",
      "repo",
      "someone/next.js",
      "done",
      true,
      true,
    ]);
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js", "next-js-2"]);
    expect(prompter.shown).toContain("warn: Already added; skipped.");
  });

  it("skips a repository already added before asking GitHub or checking candidates", async () => {
    const fetch = mockFetch(BASE_ROUTES);
    const llm = fakeLlm({ repos: () => [{ repo: "vercel/next.js", note: "" }] });
    const { prompter, result } = sources(
      ["repo", "vercel/next.js", "repo", "Vercel/Next.js", "repo", "Next.js", "done", true],
      llm.client,
    );
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js"]);
    expect(prompter.shown.filter((s) => s === "warn: Already added; skipped.")).toHaveLength(2);
    expect(fetch.calls.filter((c) => c.url.toLowerCase() === `${API}/vercel/next.js`)).toHaveLength(1);
  });

  it("does not claim a repository is missing when GitHub could not be asked", async () => {
    mockFetch({ ...BASE_ROUTES, [`${API}/acme/limited`]: reply.status(403) });
    const llm = fakeLlm({ repos: (name) => (name === "Limited" ? [{ repo: "acme/limited", note: "" }] : []) });
    const { prompter, result } = sources(["repo", "Limited", "repo", "vercel/next.js", "done", true], llm.client);
    await result;
    expect(prompter.shown).toContain(
      "warn: Could not check 1 candidate for Limited on GitHub; try again later or enter it as owner/repo.",
    );
    expect(prompter.shown.some((s) => s.includes("No GitHub repository found"))).toBe(false);
  });
});

describe("askSources: sites", () => {
  const PAGE = "https://blog.example.com/";
  const page = (links: string) => `<html><head>${links}</head><body>hi</body></html>`;

  it("asks which feed to watch when a page has several", async () => {
    mockFetch({
      [PAGE]: reply.text(
        page(
          '<link rel="alternate" type="application/atom+xml" title="Posts \u001b[2J" href="/posts.atom">' +
            '<link rel="alternate" type="application/rss+xml" title="Comments" href="/comments.rss">',
        ),
      ),
      [`${PAGE}posts.atom`]: reply.text(atom("A post")),
      [`${PAGE}comments.rss`]: reply.text(atom("A comment")),
    });
    const { prompter, result } = sources(["site", PAGE, `${PAGE}posts.atom`, "done", true]);
    expect((await result).feeds).toEqual([
      // The page's title for the feed, without control characters, tells it from the comments feed.
      { id: "blog-example-com", type: "rss", name: "blog.example.com: Posts [2J", url: `${PAGE}posts.atom` },
    ]);
    const message = `${PAGE} has 2 feeds; which one?`;
    expect(prompter.options[message]).toEqual([`${PAGE}posts.atom`, `${PAGE}comments.rss`, "none"]);
  });

  it("adds the only feed without asking, and goes back on None of these", async () => {
    mockFetch({
      [PAGE]: reply.text(
        page(
          '<link rel="alternate" type="application/atom+xml" href="/a.atom"><link rel="alternate" type="application/atom+xml" href="/b.atom">',
        ),
      ),
      [`${PAGE}a.atom`]: reply.text(atom("A")),
      [`${PAGE}b.atom`]: reply.text(atom("B")),
      [SIMON]: reply.text(atom("Simon's post")),
    });
    const { prompter, result } = sources(["site", PAGE, "none", "site", SIMON, "done", true]);
    expect((await result).feeds!.map((f) => (f.type === "rss" ? f.url : f.repo))).toEqual([SIMON]);
    expect(prompter.asked.filter((m) => m.endsWith("which one?"))).toHaveLength(1);
  });

  it("goes back when a page has no feed or cannot be opened", async () => {
    const fallbacks = ["feed", "feed/", "rss", "rss.xml", "atom.xml", "feed.xml", "index.xml"];
    mockFetch({
      ...BASE_ROUTES,
      [PAGE]: reply.text(page("")),
      ...Object.fromEntries(fallbacks.map((path) => [`${PAGE}${path}`, reply.status(404)])),
      "https://down.example.com/": reply.status(404),
    });
    const { prompter, result } = sources(["site", PAGE, "site", "https://down.example.com/", "site", SIMON, "done", true]);
    expect((await result).feeds!.map((f) => (f.type === "rss" ? f.url : f.repo))).toEqual([SIMON]);
    expect(prompter.shown).toContain(`warn: No feed found on ${PAGE}.`);
    expect(prompter.shown.some((s) => s.startsWith("warn: Could not open https://down.example.com/: "))).toBe(true);
  });

  it("names a feed served from another host after the page it was found on", async () => {
    const burner = "https://feeds.feedburner.com/example";
    mockFetch({
      [PAGE]: reply.text(page(`<link rel="alternate" type="application/rss+xml" title="Feed" href="${burner}">`)),
      [burner]: reply.text(atom("A post")),
    });
    const { prompter, result } = sources(["site", PAGE, "done", true]);
    expect((await result).feeds).toEqual([{ id: "blog-example-com", type: "rss", name: "blog.example.com", url: burner }]);
    expect(prompter.asked).toContain("Watch blog.example.com every morning?");
  });

  it("offers to add a page that may be up again later, and not one that is gone", async () => {
    // A rate limit asking to wait an hour fails at once instead of being retried.
    const limited = reply.status(429, { "retry-after": "3600" });
    mockFetch({ ...BASE_ROUTES, "https://busy.example.com/feed": [limited, limited], [PAGE]: reply.status(404) });
    const { prompter, result } = sources([
      "site",
      "https://busy.example.com/feed",
      false,
      "site",
      "https://busy.example.com/feed",
      true,
      "site",
      PAGE,
      "site",
      SIMON,
      "done",
      false,
      true,
    ]);
    expect((await result).feeds).toEqual([{ id: "simonwillison-net", type: "rss", name: "simonwillison.net/atom/everything", url: SIMON }]);
    expect(prompter.asked.filter((m) => m === "Add https://busy.example.com/feed as a feed anyway?")).toHaveLength(2);
    // Tried like any other source, and rejected here.
    expect(prompter.asked).toContain("Watch busy.example.com/feed every morning?");
    expect(prompter.asked.some((m) => m.startsWith(`Add ${PAGE}`))).toBe(false);
  });

  it("offers to add an advertised feed that failed, not the page that advertised it", async () => {
    const limited = reply.status(429, { "retry-after": "3600" });
    mockFetch({
      [PAGE]: reply.text(page('<link rel="alternate" type="application/rss+xml" href="/feed.xml">')),
      [`${PAGE}feed.xml`]: [limited, limited, reply.text(atom("Back"))],
    });
    const { prompter, result } = sources(["site", PAGE, true, "done", true]);
    expect((await result).feeds).toEqual([
      { id: "blog-example-com", type: "rss", name: "blog.example.com", url: `${PAGE}feed.xml` },
    ]);
    expect(prompter.shown.some((s) => s.startsWith(`warn: Could not check a feed on ${PAGE}: `))).toBe(true);
    expect(prompter.asked).toContain(`Add ${PAGE}feed.xml anyway?`);
  });

  it("does not offer a guessed feed path that failed", async () => {
    const fallbacks = ["feed", "feed/", "rss", "rss.xml", "atom.xml", "feed.xml", "index.xml"];
    const limited = reply.status(429, { "retry-after": "3600" });
    mockFetch({
      ...BASE_ROUTES,
      [PAGE]: reply.text(page("")),
      ...Object.fromEntries(fallbacks.map((path) => [`${PAGE}${path}`, reply.status(404)])),
      [`${PAGE}rss`]: [limited, limited],
    });
    const { prompter, result } = sources(["site", PAGE, "site", SIMON, "done", true]);
    expect((await result).feeds!.map((f) => (f.type === "rss" ? f.url : f.repo))).toEqual([SIMON]);
    expect(prompter.shown.some((s) => s.startsWith(`warn: Could not check a feed on ${PAGE}: `))).toBe(true);
    expect(prompter.asked.some((m) => m.endsWith("anyway?"))).toBe(false);
  });

  it("rejects URLs that are not absolute http(s)", async () => {
    for (const url of ["simonwillison.net", "ftp://example.com/feed", "/feed.xml"]) {
      expect(await rejection(sources(["site", url]).result)).toMatchObject({ message: expect.stringMatching(/http\(s\) URL/) });
    }
  });

  it("treats feed URLs that normalize the same as one feed", async () => {
    const other = "https://example.com/feed/?utm_source=x#top";
    const fetch = mockFetch({ "https://example.com/feed": reply.text(atom("A")), [other]: reply.text(atom("A")) });
    const { prompter, result } = sources(["site", "https://example.com/feed", "site", other, "done", true]);
    expect((await result).feeds).toEqual([
      { id: "example-com", type: "rss", name: "example.com/feed", url: "https://example.com/feed" },
    ]);
    expect(prompter.shown).toContain("warn: Already added; skipped.");
    // Known before it is fetched.
    expect(fetch.callsTo(other)).toEqual([]);
  });
});

describe("askSources: search queries", () => {
  it("skips queries without a Tavily key", async () => {
    const llm = fakeLlm();
    const { prompter, result } = sources(["repo", "vercel/next.js", "done", true], llm.client);
    expect((await result).queries).toBeUndefined();
    expect(prompter.shown).toContain("note: TAVILY_API_KEY is not set, so web search queries are skipped.");
    expect(llm.calls).toEqual([]);
  });

  it("offers up to five suggestions and takes typed queries too", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({ [TAVILY]: reply.text(await readFile(join(import.meta.dirname, "../fixtures/tavily/search.json"), "utf8")) });
    const llm = fakeLlm({ queries: () => ["Qwen release", " qwen  release ", "", "A", "B", "C", "D", "E"] });
    const { prompter, result } = sources(
      ["done", ["Qwen release", "B"], true, " qwen \t RELEASE ", "Next.js   news", "", true, false, true],
      llm.client,
    );
    expect(await result).toEqual({
      version: 1,
      feeds: [],
      queries: [
        { id: "qwen-release", query: "Qwen release", topic: "news" },
        { id: "next-js-news", query: "Next.js news", topic: "news" },
      ],
    });
    expect(prompter.options["Search queries to run every morning (space to select)"]).toEqual(["Qwen release", "A", "B", "C", "D"]);
    expect(prompter.asked).toContain("Watch B every morning?");
    // Typed queries are compared and stored as the suggestions are.
    expect(prompter.shown).toContain("warn: Already added: qwen RELEASE; skipped.");
  });

  it("stores a long suggestion whole, shortening only its label", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({ [TAVILY]: reply.text(await readFile(join(import.meta.dirname, "../fixtures/tavily/search.json"), "utf8")) });
    const long = `${"word ".repeat(30)}end`;
    const llm = fakeLlm({ queries: () => [long] });
    const { result } = sources(["done", [long], false, true], llm.client);
    expect((await result).queries!.map((q) => q.query)).toEqual([long]);
  });

  it("ignores a typed query of control characters only and names others by a hash", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({ [TAVILY]: reply.text(await readFile(join(import.meta.dirname, "../fixtures/tavily/search.json"), "utf8")) });
    const { result } = sources(["done", "\u001b\u0007", "Next.js リリース", "", true]);
    expect((await result).queries).toEqual([
      { id: queryIdFrom("Next.js リリース", new Set()), query: "Next.js リリース", topic: "news" },
    ]);
  });

  it("reads the Tavily key from the env it is given", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const prompter = scriptedPrompter(["done"]);
    const result = askSources(newSession(prompter, CONTEXT, { env: {} }));
    expect(await rejection(result)).toMatchObject({ message: expect.stringMatching(/not an option/) });
  });

  it("takes typed queries only when the model cannot suggest any", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({ [TAVILY]: reply.text(await readFile(join(import.meta.dirname, "../fixtures/tavily/search.json"), "utf8")) });
    const llm = fakeLlm({
      queries: () => {
        throw new LlmError("invalid_output", "bad");
      },
    });
    const { prompter, result } = sources(["done", "Qwen", "", true], llm.client);
    expect((await result).queries!.map((q) => q.query)).toEqual(["Qwen"]);
    expect(prompter.shown).toContain("warn: Claude could not answer (invalid_output).");
  });
});

describe("askSources: trial fetch", () => {
  it("shows the latest item of each source without control characters", async () => {
    mockFetch(repoRoutes("vercel/next.js", { releases: [release("\u001b]0;pwned\u0007v16 \u001b[31mred")] }));
    const { prompter, result } = sources(["repo", "vercel/next.js", "done", true]);
    await result;
    const shown = prompter.shown.find((s) => s.startsWith("note: vercel/next.js (github): "))!;
    expect(shown).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(shown).toContain("v16 [31mred");
  });

  it("drops rejected sources and asks again when nothing is left", async () => {
    const { prompter, result } = sources([
      "repo",
      "vercel/next.js",
      "site",
      SIMON,
      "done",
      false,
      false,
      // The rejected ones can be added again.
      "repo",
      "vercel/next.js",
      "done",
      true,
    ]);
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js"]);
    expect(prompter.shown).toContain("warn: Nothing to watch yet; add a source.");
  });

  it("reports a failing source and keeps it only when the user says so", async () => {
    mockFetch({ ...BASE_ROUTES, [SIMON]: [reply.text(atom("ok")), reply.status(410)] });
    const { prompter, result } = sources(["repo", "vercel/next.js", "site", SIMON, "done", true, false]);
    expect((await result).feeds!.map((f) => f.id)).toEqual(["next-js"]);
    expect(prompter.shown.some((s) => s.startsWith("warn: simonwillison.net/atom/everything (rss) failed: "))).toBe(true);
  });

  it("notes a source with no items yet", async () => {
    const empty = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title></feed>';
    mockFetch({ "https://quiet.example.com/feed": reply.text(empty) });
    const { prompter, result } = sources(["site", "https://quiet.example.com/feed", "done", true]);
    await result;
    expect(prompter.shown).toContain("note: quiet.example.com/feed (rss): No items yet.");
  });

  it("shows what GitHub returned while checking a repository instead of asking again", async () => {
    const fetch = mockFetch(repoRoutes("vercel/next.js"));
    const { prompter, result } = sources(["repo", "vercel/next.js", "done", true]);
    await result;
    expect(fetch.callsTo(`${API}/vercel/next.js/releases?per_page=100`)).toHaveLength(1);
    expect(prompter.shown.some((s) => s.startsWith("spin: Fetching"))).toBe(false);
    expect(prompter.shown).toContain("note: vercel/next.js (github): v16.0.0\n2026-10-24\nhttps://github.com/x/y/releases/tag/v16.0.0");
  });

  it("follows a repository whose tags are all prereleases", async () => {
    const rc = atom("v2.0.0-rc.1", "https://github.com/acme/quiet/releases/tag/v2.0.0-rc.1");
    mockFetch({ ...repoRoutes("acme/quiet", { releases: [] }), "https://github.com/acme/quiet/tags.atom": reply.text(rc) });
    const { prompter, result } = sources(["repo", "acme/quiet", "done", true]);
    expect((await result).feeds![0]).toMatchObject({ feed: "tags", includePrereleases: true });
    expect(prompter.shown).toContain("note: acme/quiet has only prereleases so far; following them.");
    expect(prompter.shown.some((s) => s.startsWith("note: acme/quiet (github): v2.0.0-rc.1"))).toBe(true);
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

describe("queryIdFrom", () => {
  it.each([
    ["Qwen model release", "qwen-model-release"],
    ["Breaking changes in the Next.js app router and server actions", "breaking-changes-in-the-next-js"],
    ["a".repeat(40), "a".repeat(32)],
  ])("%s -> %s", (query, id) => {
    expect(queryIdFrom(query, new Set())).toBe(id);
  });

  it("names a query with other characters by a hash that does not depend on order", () => {
    const id = queryIdFrom("Next.js リリース", new Set());
    expect(id).toMatch(/^query-[0-9a-f]{8}$/);
    expect(queryIdFrom("LLM 新モデル", new Set([id]))).not.toBe(id);
    expect(queryIdFrom("next.js リリース", new Set())).toBe(id);
    expect(queryIdFrom("!!!", new Set())).toMatch(/^query-[0-9a-f]{8}$/);
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

describe("runInit --from", () => {
  const PROPOSAL = {
    pochi: "proposal/v1",
    project: { name: "pecolab", description: "Pet photos to illustrations" },
    language: "Japanese",
    problems: [
      { text: "Next.js breaking changes", axis: "tech", evidence: "package.json" },
      { text: "Competing pet illustration apps", axis: "market", evidence: "knowledge" },
    ],
    exclude: [{ text: "Funding news" }],
    repos: [{ repo: "vercel/next.js", evidence: "package.json: next" }, { repo: "ghost/missing" }, { repo: "Vercel/Next.js" }],
    sites: [{ url: SIMON, evidence: "README" }],
    queries: [{ query: "pet AI illustration app", intent: "competitor", topic: "general", evidence: "README" }],
  };
  // name, description, problems picked, none of our own, exclude picked, none of our own,
  // language, channels, no ideas.
  const PROPOSAL_CONTEXT: Answer[] = [
    "pecolab",
    "Pet photos to illustrations",
    ["Next.js breaking changes", "Competing pet illustration apps"],
    false,
    [],
    false,
    "Japanese",
    ["slack"],
    false,
  ];
  const PROBLEMS = "What do you want to hear about? (proposed; space to toggle, enter to confirm)";
  const REPOS = "Proposed repositories to watch (space to toggle)";
  const SITES = "Proposed sites to watch (space to toggle)";

  async function writeProposal(value: unknown, name = "proposal.json"): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  }

  beforeEach(() => {
    mockFetch({ ...BASE_ROUTES, [`${API}/ghost/missing`]: reply.status(404) });
  });

  it("offers the proposal as the defaults and checks every source before writing", async () => {
    const from = await writeProposal(PROPOSAL);
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps([
      ...PROPOSAL_CONTEXT,
      ["vercel/next.js", "ghost/missing"],
      [SIMON],
      "done",
      true,
      true,
    ]);
    await runInit({ configDir, from }, d);
    expect(prompter.remaining).toEqual([]);

    expect(prompter.shown).toContain(
      "note: Proposal: 2 problems, 1 exclusion, 3 repositories, 1 site, 1 query.\nEach is offered to pick, and checked before anything is written.",
    );
    expect(prompter.initial).toMatchObject({
      "Project name": "pecolab",
      "Describe the project in a sentence or two (optional)": "Pet photos to illustrations",
      [PROBLEMS]: ["Next.js breaking changes", "Competing pet illustration apps"],
      "What should be dropped even if it looks related? (proposed; space to toggle, enter to confirm)": ["Funding news"],
      "Language for the summaries": "Japanese",
      // Repositories differing only in case are offered once.
      [REPOS]: ["vercel/next.js", "ghost/missing"],
      [SITES]: [SIMON],
    });
    // Whether to type more is asked, so Enter on the list does not seem to skip it.
    expect(prompter.asked).toContain("Add your own as well? (2 picked)");
    expect(prompter.asked.some((m) => m.startsWith("What do you want to hear about? (1/"))).toBe(false);
    expect(prompter.shown).toContain("warn: ghost/missing was not found on GitHub; left out.");
    expect(prompter.asked).toContain("Add another source? (2 so far)");

    const loaded = await loadConfig({ configDir, env: {} });
    expect(loaded.context).toMatchObject({
      project: { name: "pecolab", description: "Pet photos to illustrations" },
      problems: ["Next.js breaking changes", "Competing pet illustration apps"],
      exclude: [],
      language: "Japanese",
    });
    expect(loaded.sources.feeds.map((f) => f.id)).toEqual(["next-js", "simonwillison-net"]);
  });

  it("offers the proposed queries in place of Claude's, keeping their topic", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({
      ...BASE_ROUTES,
      [TAVILY]: reply.text(await readFile(join(import.meta.dirname, "../fixtures/tavily/search.json"), "utf8")),
    });
    const llm = fakeLlm({ queries: () => ["from Claude"] });
    const from = await writeProposal({ ...PROPOSAL, repos: [], sites: [] });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps(
      [...PROPOSAL_CONTEXT, "repo", "vercel/next.js", "done", ["pet AI illustration app"], false, true, true],
      // The fetch reads process.env; init reads the env it is given.
      { resolveLlm: llm.resolve, env: { TAVILY_API_KEY: "tvly-test" } },
    );
    await runInit({ configDir, from }, d);
    expect(llm.calls).toEqual([]);
    const message = "Search queries to run every morning (space to select)";
    expect(prompter.options[message]).toEqual(["pet AI illustration app"]);
    // Each costs a credit every morning, so none is picked for the user.
    expect(prompter.initial[message]).toBeUndefined();
    expect((await loadConfig({ configDir, env: {} })).sources.queries).toEqual([
      { id: "pet-ai-illustration-app", query: "pet AI illustration app", topic: "general", maxResults: 5 },
    ]);
  });

  it("leaves a language it does not list to Other, filled in", async () => {
    const from = await writeProposal({ pochi: "proposal/v1", language: "German", problems: [{ text: "News" }] });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps(["app", "", ["News"], false, "", "other", "German", ["slack"], false, ...SOURCE_ANSWERS]);
    await runInit({ configDir, from }, d);
    expect(prompter.initial["Language for the summaries"]).toBe("other");
    expect(prompter.initial.Language).toBe("German");
    // Nothing proposed for exclude, so it is asked as before.
    expect(prompter.asked).toContain("What should be dropped even if it looks related? (1/30, empty to finish)");
    expect((await loadConfig({ configDir, env: {} })).context.language).toBe("German");
  });

  it("still requires a problem when every proposed one is dropped, asking for it outright", async () => {
    const from = await writeProposal(PROPOSAL);
    const { prompter, deps: d } = deps(["app", "", [], ""]);
    expect(await rejection(runInit({ configDir: join(dir, "config"), from }, d))).toMatchObject({
      message: expect.stringMatching(/rejected .* Required/),
    });
    expect(prompter.shown).toContain("note: Add at least 1 of your own.");
    expect(prompter.asked.some((m) => m.startsWith("Add your own as well?"))).toBe(false);
  });

  it("takes entries of your own after the proposed ones when asked to", async () => {
    const from = await writeProposal(PROPOSAL);
    const configDir = join(dir, "config");
    const answers = [...PROPOSAL_CONTEXT];
    answers.splice(3, 1, true, "Supabase outages", "");
    const { prompter, deps: d } = deps([...answers, ["vercel/next.js"], [], "done", true]);
    await runInit({ configDir, from }, d);
    expect(prompter.asked).toContain("What do you want to hear about? (1/18, empty to finish)");
    expect((await loadConfig({ configDir, env: {} })).context.problems).toEqual([
      "Next.js breaking changes",
      "Competing pet illustration apps",
      "Supabase outages",
    ]);
  });

  it("warns about the entries it left out", async () => {
    const from = await writeProposal({ pochi: "proposal/v1", problems: [{ text: "News" }], repos: [{ repo: "nope" }, "x"] });
    const { prompter, deps: d } = deps(["app", "", ["News"], false, "", "English", ["slack"], false, ...SOURCE_ANSWERS]);
    await runInit({ configDir: join(dir, "config"), from }, d);
    expect(prompter.shown).toContain("warn: Left out 2 proposed entries: malformed or past the limits.");
  });

  it("does not wait for Claude when the proposal answers every step that needs it", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    let lookup: AbortSignal | undefined;
    const from = await writeProposal(PROPOSAL);
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, ["vercel/next.js"], [SIMON], "done", [], false, true, true], {
      env: { TAVILY_API_KEY: "tvly-test" },
      // Never settles, like a CLI probe that hangs.
      resolveLlm: (_, opts) => {
        lookup = opts?.signal;
        return new Promise(() => {});
      },
    });
    await runInit({ configDir: join(dir, "config"), from }, d);
    expect(prompter.asked).toContain("Search queries to run every morning (space to select)");
    expect(prompter.shown.some((s) => s.includes("Looking for Claude"))).toBe(false);
    expect(lookup?.aborted).toBe(true);
  });

  it("drops proposed queries that clean to nothing or repeat, and names non-ASCII ones by a hash", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({
      ...BASE_ROUTES,
      [TAVILY]: reply.text(await readFile(join(import.meta.dirname, "../fixtures/tavily/search.json"), "utf8")),
    });
    const from = await writeProposal({
      ...PROPOSAL,
      repos: [],
      sites: [],
      queries: [{ query: "\u0007" }, { query: "Pet  AI" }, { query: "pet ai" }, { query: "ペット イラスト" }],
    });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, "done", ["Pet AI", "ペット イラスト"], false, true, true], {
      env: { TAVILY_API_KEY: "tvly-test" },
    });
    await runInit({ configDir, from }, d);
    expect(prompter.options["Search queries to run every morning (space to select)"]).toEqual(["Pet AI", "ペット イラスト"]);
    const ids = (await loadConfig({ configDir, env: {} })).sources.queries.map((q) => q.id);
    expect(ids).toEqual(["pet-ai", expect.stringMatching(/^query-[0-9a-f]{8}$/)]);
  });

  it("says which proposed site was skipped when two lead to one feed", async () => {
    const blog = "https://blog.example.com/";
    mockFetch({
      ...BASE_ROUTES,
      [blog]: reply.text(`<html><head><link rel="alternate" type="application/atom+xml" href="${SIMON}"></head></html>`),
    });
    const from = await writeProposal({ ...PROPOSAL, repos: [], sites: [{ url: blog }, { url: SIMON }] });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, [blog, SIMON], "done", true]);
    await runInit({ configDir, from }, d);
    expect(prompter.shown).toContain("spin: Looking for feeds on 2 sites");
    expect(prompter.shown).toContain("warn: Already added: simonwillison.net/atom/everything; skipped.");
    expect((await loadConfig({ configDir, env: {} })).sources.feeds).toEqual([expect.objectContaining({ url: SIMON })]);
  });

  it("leaves out a proposed site it could not check instead of offering to add it anyway", async () => {
    const down = "https://down.example.com/";
    mockFetch({ ...BASE_ROUTES, [down]: reply.status(503) });
    const from = await writeProposal({ ...PROPOSAL, repos: [], sites: [{ url: down }, { url: SIMON }] });
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, [down, SIMON], "done", true]);
    await runInit({ configDir: join(dir, "config"), from }, d);
    expect(prompter.shown.some((s) => s.startsWith(`warn: Could not open ${down}`) && s.endsWith("; left out"))).toBe(true);
    expect(prompter.asked.some((m) => m.includes("anyway"))).toBe(false);
  });

  it("says the proposed queries are left out without a Tavily key", async () => {
    const from = await writeProposal(PROPOSAL);
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, ["vercel/next.js"], [], "done", true]);
    await runInit({ configDir: join(dir, "config"), from }, d);
    expect(prompter.shown).toContain(
      "note: TAVILY_API_KEY is not set, so web search queries are skipped (1 proposed query left out).",
    );
  });

  it("offers proposed entries once whatever their case, and refuses typing one again", async () => {
    const from = await writeProposal({
      pochi: "proposal/v1",
      problems: [{ text: "Next.js breaking changes" }, { text: "next.js Breaking Changes" }],
    });
    const { prompter, deps: d } = deps(["app", "", ["Next.js breaking changes"], true, "NEXT.JS BREAKING CHANGES"]);
    expect(await rejection(runInit({ configDir: join(dir, "config"), from }, d))).toMatchObject({
      message: expect.stringMatching(/Already in the list/),
    });
    expect(prompter.options[PROBLEMS]).toEqual(["Next.js breaking changes"]);
  });

  it("fails with 2 before asking anything when the file cannot be used", async () => {
    for (const from of [join(dir, "missing.json"), await writeProposal("I could not finish.", "bad.md")]) {
      const { prompter, deps: d } = deps([]);
      const err = await rejection(runInit({ configDir: join(dir, "config"), from }, d));
      expect(err).toBeInstanceOf(ConfigError);
      expect(prompter.asked).toEqual([]);
      expect(prompter.shown).toEqual([]);
    }
  });
});

describe("runInit --print-prompt", () => {
  it("prints the prompt and asks nothing, even off a terminal", async () => {
    let out = "";
    const { prompter, deps: d } = deps([], { isInteractive: () => false, stdout: (s) => (out += s) });
    await runInit({ configDir: dir, printPrompt: true }, d);
    expect(out).toContain('"pochi": "proposal/v1"');
    expect(prompter.asked).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("cannot be combined with --from", async () => {
    const { deps: d } = deps([], { stdout: () => undefined });
    expect(await rejection(runInit({ printPrompt: true, from: "x.json" }, d))).toBeInstanceOf(ConfigError);
  });
});

describe("runInit: ideas from Claude", () => {
  const ASK = "Ask Claude for ideas from technology, design and marketing angles you may have missed?";
  const IDEAS = "Ideas to add to what you want to hear about (space to select, enter to confirm)";
  const QUERIES = "Search queries to run every morning (space to select)";
  // CONTEXT_ANSWERS up to the channels, without its "no ideas".
  const BEFORE_IDEAS = CONTEXT_ANSWERS.slice(0, -1);
  const DESIGN = {
    perspective: "design" as const,
    problem: "Accessibility  rules for pet apps",
    why: "App store reviews check it",
    sites: [SIMON, "not a url"],
    queries: ["WCAG 3 draft", "a", "b"],
  };

  beforeEach(async () => {
    mockFetch({
      ...BASE_ROUTES,
      [TAVILY]: reply.text(await readFile(join(import.meta.dirname, "../fixtures/tavily/search.json"), "utf8")),
    });
  });

  it("adds the ideas picked to the interests and offers their sites and queries as sources", async () => {
    const llm = fakeLlm({
      queries: () => ["from Claude"],
      ideas: () => [
        DESIGN,
        // Already an interest, whatever its case.
        { perspective: "tech", problem: "next.js BREAKING changes", why: "", sites: [], queries: [] },
        { perspective: "marketing", problem: "Pet app SEO", why: "", sites: ["https://seo.example.com/"], queries: [] },
      ],
    });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps(
      [...BEFORE_IDEAS, true, ["Accessibility rules for pet apps"], [SIMON], "done", ["WCAG 3 draft"], false, true, true],
      { resolveLlm: llm.resolve, env: { TAVILY_API_KEY: "tvly-test" } },
    );
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    await runInit({ configDir }, d);
    expect(prompter.remaining).toEqual([]);

    expect(prompter.asked).toContain(ASK);
    expect(prompter.options[IDEAS]).toEqual(["Accessibility rules for pet apps", "Pet app SEO"]);
    // Each brings more news every morning, so none is picked for the user.
    expect(prompter.initial[IDEAS]).toBeUndefined();
    // Only the sites of the ideas picked, and only the ones that are URLs.
    expect(prompter.options["Proposed sites to watch (space to toggle)"]).toEqual([SIMON]);
    // Up to two queries an idea, offered with Claude's own suggestions.
    expect(prompter.options[QUERIES]).toEqual(["from Claude", "WCAG 3 draft", "a"]);

    const loaded = await loadConfig({ configDir, env: {} });
    expect(loaded.context.problems).toEqual(["Next.js breaking changes", "日本語の課題", "Accessibility rules for pet apps"]);
    expect(loaded.sources.feeds).toEqual([expect.objectContaining({ url: SIMON })]);
    expect(loaded.sources.queries.map((q) => q.query)).toEqual(["WCAG 3 draft"]);
    // The query suggestions were asked for with the new interest in the context.
    expect(llm.calls).toEqual(["ideas", "queries"]);
  });

  it("does not ask Claude when declined", async () => {
    const llm = fakeLlm();
    const { deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS], { resolveLlm: llm.resolve });
    await runInit({ configDir: dir }, d);
    expect(llm.calls).not.toContain("ideas");
  });

  it("carries on without ideas when Claude fails or has none", async () => {
    for (const ideas of [
      () => {
        throw new LlmError("unavailable", "down");
      },
      () => [],
    ]) {
      const llm = fakeLlm({ ideas });
      const { prompter, deps: d } = deps([...BEFORE_IDEAS, true, ...SOURCE_ANSWERS], { resolveLlm: llm.resolve });
      await runInit({ configDir: dir }, d);
      expect(prompter.remaining).toEqual([]);
      expect(prompter.asked).not.toContain(IDEAS);
      expect((await loadConfig({ configDir: dir, env: {} })).context.problems).toHaveLength(2);
      await rm(join(dir, "context.yml"));
      await rm(join(dir, "sources.yml"));
    }
  });
});
