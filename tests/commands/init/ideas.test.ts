import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../../../src/commands/init/flow.js";
import { loadConfig } from "../../../src/config/load.js";
import { LlmError } from "../../../src/llm/schema.js";
import { mockFetch, reply } from "../../helpers/mockFetch.js";
import {
  BASE_ROUTES,
  CONTEXT_ANSWERS,
  ON_ACTIONS,
  SIMON,
  SOURCE_ANSWERS,
  TAVILY,
  TAVILY_FIXTURE,
  deps,
  dir,
  fakeLlm,
  useInitSandbox,
} from "./fixtures.js";

useInitSandbox();

describe("runInit: ideas from Claude", () => {
  const ASK = "Ask Claude for ideas from technology, design, marketing and industry angles you may have missed?";
  const IDEAS = "Ideas to add to what you want to hear about (space to select, enter to confirm)";
  const QUERIES = "News searches to run (Google News, free; space to select)";
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
      [TAVILY]: reply.text(await readFile(TAVILY_FIXTURE, "utf8")),
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
      [...BEFORE_IDEAS, true, ["Accessibility rules for pet apps"], [SIMON], "done", ["WCAG 3 draft"], "", true, ON_ACTIONS],
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
    // Up to two queries an idea, offered with Claude's own suggestions; the idea's are picked.
    expect(prompter.options[QUERIES]).toEqual(["from Claude", "WCAG 3 draft", "a"]);
    expect(prompter.initial[QUERIES]).toEqual(["WCAG 3 draft", "a"]);

    const loaded = await loadConfig({ configDir, env: {} });
    expect(loaded.context.problems).toEqual(["Next.js breaking changes", "日本語の課題", "Accessibility rules for pet apps"]);
    expect(loaded.sources.feeds[0]).toEqual(expect.objectContaining({ url: SIMON }));
    expect(loaded.sources.feeds.map((f) => ("query" in f ? f.query : f.name))).toContain("WCAG 3 draft");
    // The query suggestions were asked for with the new interest in the context.
    expect(llm.calls).toEqual(["ideas", "queries"]);
  });

  it("says how many interests there are before asking for ideas", async () => {
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir: dir }, d);
    expect(prompter.shown).toContain("note: Interests: 2 of 50 interests so far.");
  });

  it("does not ask Claude when declined", async () => {
    const llm = fakeLlm();
    const { deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS], { resolveLlm: llm.resolve });
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
      const { prompter, deps: d } = deps([...BEFORE_IDEAS, true, ...SOURCE_ANSWERS, ON_ACTIONS], { resolveLlm: llm.resolve });
      await runInit({ configDir: dir }, d);
      expect(prompter.remaining).toEqual([]);
      expect(prompter.asked).not.toContain(IDEAS);
      expect((await loadConfig({ configDir: dir, env: {} })).context.problems).toHaveLength(2);
      await rm(join(dir, "context.yml"));
      await rm(join(dir, "sources.yml"));
    }
  });
});
