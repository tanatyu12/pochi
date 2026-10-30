import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { InitDeps } from "../../../src/commands/init/flow.js";
import { askSources } from "../../../src/commands/init/sources.js";
import { newSession } from "../../../src/commands/init/session.js";
import { ContextSchema } from "../../../src/config/schema.js";
import type { resolveLlm } from "../../../src/llm/adapter.js";
import {
  type GenerateRequest,
  IdeaSuggestionOutputSchema,
  type IdeaSuggestionOutput,
  type LlmClient,
  LlmError,
  QuerySuggestionOutputSchema,
  RepoInferenceOutputSchema,
} from "../../../src/llm/schema.js";
import { fakeExec } from "../../helpers/fakeExec.js";
import { type Route, mockFetch, reply } from "../../helpers/mockFetch.js";
import { type Answer, scriptedPrompter } from "../../helpers/scriptedPrompter.js";

// Shared by the init tests: canned routes, answers and fakes for a whole interview.

export const FIXTURES = join(import.meta.dirname, "../../fixtures/feeds");
export const API = "https://api.github.com/repos";
export const SIMON = "https://simonwillison.net/atom/everything/";
// A feed with nothing in it yet, so the trial fetch asks whether to keep it.
export const QUIET = "https://quiet.example.com/feed";
export const TAVILY = "https://api.tavily.com/search";
export const TAVILY_FIXTURE = join(import.meta.dirname, "../../fixtures/tavily/search.json");

export const CHANNELS = "Where should the briefing go? (space to toggle)";
export const NEWS = "News searches to run (Google News, free; space to select)";
export const WEB = "Web searches to run (Tavily, paid; space to select)";
// Every day at the default time, asked right after the channels.
export const SCHEDULE_ANSWERS: Answer[] = ["daily", "06:17"];
// name, description, problems (ended by ""), exclude (ended by ""), language, channels, schedule, no ideas.
export const CONTEXT_ANSWERS: Answer[] = [
  "my-app",
  "A SaaS app: Next.js\nand Postgres",
  "Next.js breaking changes",
  "日本語の課題",
  "",
  "Funding news",
  "",
  "Japanese",
  ["slack"],
  ...SCHEDULE_ANSWERS,
  false,
];
// Asked last with Slack: run on GitHub Actions, as the next steps for Slack assume.
export const ON_ACTIONS: Answer = "github";
// Two sources; both bring an item, so the trial fetch asks nothing.
export const SOURCE_ANSWERS: Answer[] = ["repo", "vercel/next.js", "site", SIMON, "done"];

export const CONTEXT = ContextSchema.parse({ version: 1, project: { name: "app", description: "" }, problems: ["News"] });

export function atom(title: string, link = "https://example.com/post"): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<entry><id>${link}</id><title>${title}</title><link rel="alternate" type="text/html" href="${link}"/>
<updated>2026-10-25T00:00:00Z</updated><content type="html">body</content></entry></feed>`;
}

export function release(name: string, prerelease = false) {
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
export function repoRoutes(repo: string, opts: { fullName?: string; releases?: unknown[] } = {}): Record<string, Route> {
  const current = opts.fullName ?? repo;
  return {
    [`${API}/${repo}`]: reply.json({ full_name: current }),
    [`${API}/${current}/releases?per_page=100`]: reply.json(opts.releases ?? [release("v16.0.0")]),
  };
}

export const EMPTY_FEED = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title></feed>';

export const BASE_ROUTES: Record<string, Route> = {
  ...repoRoutes("vercel/next.js"),
  [SIMON]: reply.text(atom("Simon's post")),
  [QUIET]: reply.text(EMPTY_FEED),
};

/** Answers repo lookups with repos(name), query suggestions with queries() and ideas with ideas(); any may throw. */
export function fakeLlm(
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

export const noLlm: typeof resolveLlm = async () => {
  throw new LlmError("unavailable", "no LLM available");
};

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

export let dir: string;
let previousUmask: number;

/** A temporary config dir per test, no Tavily or GitHub token, and the base routes stubbed. */
export function useInitSandbox(): void {
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
}

export function deps(answers: Answer[], overrides: Partial<InitDeps> = {}) {
  const prompter = scriptedPrompter(answers);
  return {
    prompter,
    deps: {
      prompter,
      isInteractive: () => true,
      checkIgnored: async (paths: string[]) => paths.map(() => true),
      env: {},
      resolveLlm: noLlm,
      timeZone: "Asia/Tokyo",
      // Never the real launchctl or crontab.
      schedule: { platform: "darwin" as const, cwd: dir, home: dir, uid: 501, exec: fakeExec().exec, scriptPath: "/app/dist/pochi.mjs" },
      ...overrides,
    },
  };
}

/** Runs askSources on scripted answers, with the LLM client given (none by default). */
export function sources(answers: Answer[], llm?: LlmClient) {
  const prompter = scriptedPrompter(answers);
  const result = askSources(newSession(prompter, CONTEXT, { llm })).then((r) => {
    expect(prompter.remaining).toEqual([]);
    return r;
  });
  return { prompter, result };
}
