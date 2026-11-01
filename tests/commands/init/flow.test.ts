import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "../../../src/commands/init/flow.js";
import { queryIdFrom } from "../../../src/commands/init/ids.js";
import { ConfigError, loadConfig } from "../../../src/config/load.js";
import { ExitCode } from "../../../src/errors.js";
import { LlmError } from "../../../src/llm/schema.js";
import { PromptCancelled } from "../../../src/util/prompter.js";
import { fakeExec } from "../../helpers/fakeExec.js";
import { mockFetch, reply } from "../../helpers/mockFetch.js";
import { type Answer, BACK, CANCEL } from "../../helpers/scriptedPrompter.js";
import {
  API,
  BASE_ROUTES,
  CHANNELS,
  CONTEXT_ANSWERS,
  EMPTY_FEED,
  NEWS,
  ON_ACTIONS,
  QUIET,
  SCHEDULE_ANSWERS,
  SIMON,
  SOURCE_ANSWERS,
  TAVILY,
  TAVILY_FIXTURE,
  WEB,
  deps,
  dir,
  fakeLlm,
  rejection,
  useInitSandbox,
} from "./fixtures.js";

useInitSandbox();

describe("runInit", () => {
  it("writes a config that loads back to the answers, readable by the owner only", async () => {
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
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
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir: dir }, d);
    expect(prompter.shown.filter((s) => s.includes("Continuing without Claude"))).toEqual([
      "warn: no LLM available. Continuing without Claude: enter repositories as owner/repo.",
    ]);
    expect(prompter.asked).toContain("GitHub repository (empty to go back)");
  });

  it("passes the env and the parsed llm settings to resolveLlm", async () => {
    const llm = fakeLlm();
    const seen: unknown[] = [];
    const { deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS], {
      env: { ANTHROPIC_API_KEY: "k" },
      resolveLlm: async (settings, opts) => {
        seen.push(settings, opts?.env);
        return llm.resolve(settings, opts);
      },
    });
    await runInit({ configDir: dir }, d);
    expect(seen).toEqual([{ provider: "auto", maxItemsPerCall: 40, maxItemsPerRun: 150 }, { ANTHROPIC_API_KEY: "k" }]);
    // Both sources were typed in full, so the model was only asked for searches.
    expect(llm.calls).toEqual(["queries"]);
  });

  it("waits for Claude only when a step needs it, and stops the lookup when done", async () => {
    let lookup: AbortSignal | undefined;
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, "site", SIMON, "done", ON_ACTIONS], {
      // Settles late, like a slow CLI probe.
      resolveLlm: (_, opts) => {
        lookup = opts?.signal;
        return new Promise((_, reject) => setTimeout(() => reject(new LlmError("unavailable", "no claude")), 20));
      },
    });
    await runInit({ configDir: dir }, d);
    // The site needs no Claude; only the search suggestions after the menu wait for it.
    expect(prompter.shown.filter((s) => s.includes("Looking for Claude"))).toEqual(["spin: Looking for Claude"]);
    expect(lookup?.aborted).toBe(true);
  });

  describe("going back (Shift+Tab)", () => {
    const urls = (mock: ReturnType<typeof mockFetch>) => mock.calls.map((c) => c.url).sort();

    it("asks the question before again with its answer, and changes only what is answered anew", async () => {
      const answers = [...CONTEXT_ANSWERS];
      // At the description, back to the name, which is changed.
      answers.splice(1, 0, BACK, "renamed");
      // At the time, back to how often, from every day to Fridays.
      const at = answers.indexOf("06:17");
      answers.splice(at, 1, BACK, "weekly", ["friday"], "07:00");
      const { prompter, deps: d } = deps([...answers, ...SOURCE_ANSWERS, ON_ACTIONS]);
      await runInit({ configDir: dir }, d);
      expect(prompter.remaining).toEqual([]);
      expect(prompter.initial["Project name"]).toBe("my-app");
      expect(prompter.initial["When should pochi run?"]).toBe("daily");
      const { context } = await loadConfig({ configDir: dir, env: {} });
      expect(context.project.name).toBe("renamed");
      expect(context.problems).toEqual(["Next.js breaking changes", "日本語の課題"]);
      expect(context.schedule).toMatchObject({ interval: "weekly", day: "friday", time: "07:00" });
    });

    it("fetches and asks Claude nothing again when going back over it", async () => {
      // Two feeds with nothing in them yet, so the trial fetch asks about each.
      const other = "https://quiet.example.com/other";
      const routes = { ...BASE_ROUTES, [other]: reply.text(EMPTY_FEED) };
      const quiet: Answer[] = ["repo", "vercel/next.js", "site", QUIET, "site", other, "done"];
      const once = mockFetch(routes);
      const llm = fakeLlm({ queries: () => [] });
      await runInit({ configDir: dir }, deps([...CONTEXT_ANSWERS, ...quiet, true, true, ON_ACTIONS], { resolveLlm: llm.resolve }).deps);
      const fetched = urls(once);

      await rm(dir, { recursive: true, force: true });
      const again = mockFetch(routes);
      const llm2 = fakeLlm({ queries: () => [] });
      // At the trial fetch of the second feed, back to the first one's, which is answered again.
      const answers: Answer[] = [...CONTEXT_ANSWERS, ...quiet, true, BACK, true, true, ON_ACTIONS];
      const { prompter, deps: d } = deps(answers, { resolveLlm: llm2.resolve });
      await runInit({ configDir: dir }, d);
      expect(prompter.remaining).toEqual([]);
      expect(urls(again)).toEqual(fetched);
      expect(llm2.calls).toEqual(llm.calls);
    });

    it("cannot go back once the files are written", async () => {
      const answers = ["app", "", "Problem", "", "", "English", ["file"], ...SCHEDULE_ANSWERS, false, ...SOURCE_ANSWERS];
      const { prompter, deps: d } = deps([...answers, BACK, false]);
      await runInit({ configDir: dir }, d);
      const ask = prompter.asked.filter((m) => m.startsWith("Install the schedule"));
      expect(ask).toHaveLength(2);
      expect(prompter.remaining).toEqual([]);
    });
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

  // The quiet feed is asked about at the trial fetch.
  const answers = [...CONTEXT_ANSWERS, "repo", "vercel/next.js", "site", QUIET, "done", true];
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
    const { deps: d } = deps([true, ...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir: dir }, d);
    expect((await loadConfig({ configDir: dir, env: {} })).context.project.name).toBe("my-app");
  });

  it("refuses to overwrite a file that appeared during the interview, which nobody agreed to", async () => {
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
    const text: typeof prompter.text = async (opts) => {
      // Another editor or init run writes it while this one is asking.
      if (opts.message === "Project name") await writeFile(join(dir, "sources.yml"), "# meanwhile\n");
      return prompter.text(opts);
    };
    const err = await rejection(runInit({ configDir: dir }, { ...d, prompter: { ...prompter, text } }));
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain("refusing to overwrite");
    expect(await readFile(join(dir, "sources.yml"), "utf8")).toBe("# meanwhile\n");
    expect(await readdir(dir)).toEqual(["sources.yml"]);
  });

  it("asks for another language when Other is chosen and leaves exclude out when empty", async () => {
    const { deps: d } = deps(["app", "", "Problem", "", "", "other", "Swahili", ["slack"], ...SCHEDULE_ANSWERS, false, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir: dir }, d);
    const text = await readFile(join(dir, "context.yml"), "utf8");
    expect(text).not.toContain("exclude");
    expect((await loadConfig({ configDir: dir, env: {} })).context.language).toBe("Swahili");
  });

  it("starts the channels from files, which need no secret", async () => {
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir: dir }, d);
    expect(prompter.initial[CHANNELS]).toEqual(["file"]);
  });

  it("starts the channels from the ones being overwritten, keeping their settings", async () => {
    const old = (channels: string) =>
      `version: 1\nproject: { name: old, description: "" }\nproblems: [p]\nnotify: { channels: ${channels} }\n`;
    const answers = ["app", "", "Problem", "", "", "English", ["file"], ...SCHEDULE_ANSWERS, false, ...SOURCE_ANSWERS, false];
    await writeFile(join(dir, "context.yml"), old("[{ type: file, dir: briefs }]"));
    const first = deps([true, ...answers]);
    await runInit({ configDir: dir }, first.deps);
    expect(first.prompter.initial[CHANNELS]).toEqual(["file"]);
    expect((await loadConfig({ configDir: dir, env: {} })).context.notify.channels).toEqual([{ type: "file", dir: "briefs" }]);

    await writeFile(join(dir, "context.yml"), old("[{ type: slack }]"));
    const second = deps([true, ...answers]);
    await runInit({ configDir: dir }, second.deps);
    expect(second.prompter.initial[CHANNELS]).toEqual(["slack"]);
  });

  it("asks again until a channel is picked, and leaves the Actions steps out for files only", async () => {
    const { prompter, deps: d } = deps(["app", "", "Problem", "", "", "English", [], ["file"], ...SCHEDULE_ANSWERS, false, ...SOURCE_ANSWERS, false]);
    await runInit({ configDir: dir }, d);
    expect(prompter.shown).toContain("warn: Pick at least one.");
    expect((await loadConfig({ configDir: dir, env: {} })).context.notify.channels).toEqual([
      { type: "file", dir: "reports" },
    ]);
    const steps = prompter.shown.find((s) => s.startsWith("note: Next steps: "))!;
    expect(steps).toContain(`node dist/pochi.mjs run --config-dir`);
    expect(steps).toContain(`node dist/pochi.mjs schedule install --config-dir`);
    expect(steps).not.toContain("gh secret set");
  });

  describe("schedule", () => {
    // The schedule answers go right after the channels; install is the answer to the offer at the end.
    const fileOnly = (schedule: Answer[], install?: boolean): Answer[] => [
      ...["app", "", "Problem", "", "", "English", ["file"]],
      ...schedule,
      false,
      ...SOURCE_ANSWERS,
      ...(install === undefined ? [] : [install]),
    ];
    const NOW = new Date("2026-10-29T03:30:00Z"); // Thu 12:30 in Tokyo

    it("writes the days, time and machine zone, asking again until a day is picked", async () => {
      const answers = fileOnly(["weekly", [], ["thursday", "friday", "saturday"], "06:17"], false);
      const { prompter, deps: d } = deps(answers);
      await runInit({ configDir: dir }, d);
      expect(prompter.shown).toContain("warn: Pick at least one day.");
      expect(prompter.initial["Days to run on (space to select)"]).toEqual(["monday"]);
      expect((await loadConfig({ configDir: dir, env: {} })).context.schedule).toEqual({
        interval: "weekly",
        day: ["thursday", "friday", "saturday"],
        time: "06:17",
        timezone: "Asia/Tokyo",
      });
    });

    it("writes one day as a single value and rejects a time that is not HH:MM", async () => {
      const { deps: d } = deps(fileOnly(["weekly", ["monday"], "25:00"]));
      expect(String(await rejection(runInit({ configDir: dir }, d)))).toContain('rejected "25:00"');
      const ok = deps(fileOnly(["weekly", ["monday"], "07:00"], false));
      await runInit({ configDir: dir }, ok.deps);
      expect(await readFile(join(dir, "context.yml"), "utf8")).toMatch(/day: monday\n/);
    });

    it("offers the schedule being overwritten as the defaults, and keeps one set by hand", async () => {
      const old = (schedule: string) =>
        `version: 1\nproject: { name: old, description: "" }\nproblems: [p]\nschedule: ${schedule}\n`;
      await writeFile(join(dir, "context.yml"), old('{ interval: weekly, day: [friday], time: "21:00", timezone: UTC }'));
      const first = deps([true, ...fileOnly(["weekly", ["friday"], "21:00"], false)]);
      await runInit({ configDir: dir }, first.deps);
      expect(first.prompter.initial).toMatchObject({
        "When should pochi run?": "weekly",
        "Days to run on (space to select)": ["friday"],
        "Time to run (HH:MM, 24-hour)": "21:00",
      });
      expect((await loadConfig({ configDir: dir, env: {} })).context.schedule.timezone).toBe("UTC");

      await writeFile(join(dir, "context.yml"), old('{ interval: cron, cronjob: "0 9 * * 1-5" }'));
      const second = deps([true, ...fileOnly(["keep"], false)]);
      await runInit({ configDir: dir }, second.deps);
      expect(second.prompter.options["When should pochi run?"]).toEqual(["daily", "weekly", "keep"]);
      expect((await loadConfig({ configDir: dir, env: {} })).context.schedule).toMatchObject({
        interval: "cron",
        cronjob: "0 9 * * 1-5",
      });
    });

    it("installs the job when asked, showing the next runs, and points the next steps at status", async () => {
      const { exec, calls } = fakeExec();
      const { prompter, deps: d } = deps(fileOnly(["weekly", ["thursday", "friday", "saturday"], "06:17"], true), {
        schedule: { platform: "darwin", cwd: dir, home: dir, uid: 501, exec, scriptPath: "/app/dist/pochi.mjs", now: () => NOW, timeZone: "Asia/Tokyo" },
      });
      await runInit({ configDir: dir }, d);
      expect(prompter.asked).toContain(
        "Install the schedule on this machine now (weekly on Thursday, Friday and Saturday at 06:17 (Asia/Tokyo))?",
      );
      expect(calls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap"]);
      const shown = prompter.shown.find((s) => s.startsWith("note: Schedule: "))!;
      expect(shown).toContain("Next runs: Fri 2026-10-30 06:17, Sat 2026-10-31 06:17, Thu 2026-11-05 06:17");
      const steps = prompter.shown.find((s) => s.startsWith("note: Next steps: "))!;
      expect(steps).toContain("schedule status");
      expect(steps).not.toContain("schedule install");
    });

    it("warns and leaves the install to the next steps when it fails", async () => {
      const exec = fakeExec(() => ({ code: 5, stderr: "Bootstrap failed" })).exec;
      const { prompter, deps: d } = deps(fileOnly(["daily", "06:17"], true), {
        schedule: { platform: "darwin", cwd: dir, home: dir, uid: 501, exec, scriptPath: "/app/dist/pochi.mjs" },
      });
      await runInit({ configDir: dir }, d);
      expect(prompter.shown.some((s) => s.startsWith("warn: Could not install the schedule: "))).toBe(true);
      expect(prompter.shown.find((s) => s.startsWith("note: Next steps: "))).toContain("schedule install");
    });

    it("does not offer an install that cannot work when run from source", async () => {
      const { exec, calls } = fakeExec();
      // The second run is asked to overwrite the files of the first.
      for (const answers of [fileOnly(["daily", "06:17"]), [true, ...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, "local"]]) {
        const { prompter, deps: d } = deps(answers, {
          schedule: { platform: "darwin", cwd: dir, home: dir, uid: 501, exec, scriptPath: "/app/src/cli.ts" },
        });
        await runInit({ configDir: dir }, d);
        expect(prompter.remaining).toEqual([]);
        expect(prompter.asked.some((m) => m.startsWith("Install the schedule"))).toBe(false);
        expect(
          prompter.shown.some((s) => s.startsWith("warn: The schedule was not installed: init is running from source.")),
        ).toBe(true);
        expect(prompter.shown.find((s) => s.startsWith("note: Next steps: "))).toContain("schedule install");
      }
      expect(calls).toEqual([]);
    });

    it("warns and carries on when the job file cannot be written", async () => {
      const { exec, calls } = fakeExec();
      // home is a file, so ~/Library/LaunchAgents cannot be created.
      await writeFile(join(dir, "home"), "");
      const { prompter, deps: d } = deps(fileOnly(["daily", "06:17"], true), {
        schedule: { platform: "darwin", cwd: dir, home: join(dir, "home"), uid: 501, exec, scriptPath: "/app/dist/pochi.mjs" },
      });
      await runInit({ configDir: dir }, d);
      expect(prompter.shown.find((s) => s.startsWith("warn: Could not install the schedule: "))).toMatch(
        /could not create .*LaunchAgents \(E[A-Z]+\)$/,
      );
      expect(prompter.shown.find((s) => s.startsWith("note: Next steps: "))).toContain("schedule install");
      expect(calls).toEqual([]);
    });

    it("does not install from the files when POCHI_*_YAML would be read instead", async () => {
      const { exec, calls } = fakeExec();
      const env = { POCHI_SOURCES_YAML: "version: 1\n" };
      // The second run is asked to overwrite the files of the first.
      for (const answers of [fileOnly(["daily", "06:17"]), [true, ...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, "local"]]) {
        const { prompter, deps: d } = deps(answers, {
          env,
          schedule: { platform: "darwin", cwd: dir, home: dir, uid: 501, exec, scriptPath: "/app/dist/pochi.mjs" },
        });
        await runInit({ configDir: dir }, d);
        expect(prompter.remaining).toEqual([]);
        expect(prompter.asked.some((m) => m.startsWith("Install the schedule"))).toBe(false);
        expect(prompter.shown).toContain(
          `warn: The schedule was not installed: POCHI_SOURCES_YAML would be used instead of the files just written. Unset it, then run \`node dist/pochi.mjs schedule install --config-dir ${dir}\`.`,
        );
        expect(prompter.shown.find((s) => s.startsWith("note: Next steps: "))).toContain("schedule install");
      }
      expect(calls).toEqual([]);
    });

    const WHERE = "Where should pochi run on schedule?";

    it("asks where a Slack setup runs, and installs it here without asking again", async () => {
      const { exec, calls } = fakeExec();
      const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, "local"], {
        schedule: { platform: "darwin", cwd: dir, home: dir, uid: 501, exec, scriptPath: "/app/dist/pochi.mjs" },
      });
      await runInit({ configDir: dir }, d);
      expect(prompter.options[WHERE]).toEqual(["local", "github"]);
      expect(prompter.initial[WHERE]).toBe("local");
      expect(prompter.asked.some((m) => m.startsWith("Install the schedule"))).toBe(false);
      expect(calls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap"]);
      const steps = prompter.shown.find((s) => s.startsWith("note: Next steps: "))!;
      expect(steps).toContain("schedule status");
      expect(steps).not.toContain("gh secret set");
    });

    it("installs nothing for a Slack setup run on Actions", async () => {
      const { exec, calls } = fakeExec();
      const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS], {
        schedule: { platform: "darwin", cwd: dir, home: dir, uid: 501, exec, scriptPath: "/app/dist/pochi.mjs" },
      });
      await runInit({ configDir: dir }, d);
      expect(prompter.asked.some((m) => m.startsWith("Install the schedule"))).toBe(false);
      expect(calls).toEqual([]);
      expect(prompter.shown.find((s) => s.startsWith("note: Next steps: "))).toContain("schedule install --backend github");
    });

    it("keeps the files and shows the Actions steps when cancelled at where to run", async () => {
      const { exec, calls } = fakeExec();
      const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, CANCEL], {
        schedule: { platform: "darwin", cwd: dir, home: dir, uid: 501, exec, scriptPath: "/app/dist/pochi.mjs" },
      });
      await runInit({ configDir: dir }, d);
      expect(calls).toEqual([]);
      expect(await readdir(dir)).toEqual(expect.arrayContaining(["context.yml", "sources.yml"]));
      expect(prompter.shown.find((s) => s.startsWith("note: Next steps: "))).toContain("gh secret set");
    });
  });

  it("requires a project name and at least one problem", async () => {
    expect(await rejection(runInit({ configDir: dir }, deps(["  "]).deps))).toMatchObject({
      message: expect.stringMatching(/rejected .* Required/),
    });
    expect(await rejection(runInit({ configDir: dir }, deps(["app", "", ""]).deps))).toMatchObject({
      message: expect.stringMatching(/rejected .* Required/),
    });
  });

  it("stops asking for problems at 50", async () => {
    const problems = Array.from({ length: 50 }, (_, i) => `Problem ${i + 1}`);
    const { prompter, deps: d } = deps(["app", "", ...problems, "", "English", ["slack"], ...SCHEDULE_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir: dir }, d);
    expect(prompter.asked.filter((m) => m.startsWith("What do you want to hear about?"))).toHaveLength(50);
    expect((await loadConfig({ configDir: dir, env: {} })).context.problems).toEqual(problems);
  });

  it("warns when git does not ignore the files and notes when it cannot tell", async () => {
    const checked: string[][] = [];
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS], {
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
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
    const { checkIgnored: _, ...withoutCheck } = d;
    await runInit({ configDir: dir }, withoutCheck);
    expect(prompter.shown).toContain(`note: Could not check whether git ignores ${join(dir, "context.yml")}.`);
  });

  it("points the next steps at the config dir used, quoted for the shell", async () => {
    const spaced = join(dir, "my configs");
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir: spaced }, d);
    const steps = prompter.shown.find((s) => s.startsWith("note: Next steps: "))!;
    expect(steps).toContain(`run --dry-run --config-dir '${spaced}'`);
    expect(steps).toContain(`gh secret set POCHI_CONTEXT_YAML < '${join(spaced, "context.yml")}'`);
  });

  it("leaves --config-dir out of the next steps for the default dir", async () => {
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS]);
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
        "node dist/pochi.mjs schedule install --backend github",
      ].join("\n"),
    );
  });

  it("warns when the env vars would override the files, without showing their values", async () => {
    const secret = "project: { name: leaked-value }";
    const { prompter, deps: d } = deps([...CONTEXT_ANSWERS, ...SOURCE_ANSWERS, ON_ACTIONS], {
      env: { POCHI_CONTEXT_YAML: secret, POCHI_SOURCES_YAML: "  ", SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" },
    });
    await runInit({ configDir: dir }, d);
    expect(prompter.shown).toContain("warn: POCHI_CONTEXT_YAML is set and takes precedence over the files just written.");
    expect(prompter.shown.join("\n")).not.toContain("POCHI_SOURCES_YAML is set");
    expect(prompter.shown.join("\n")).not.toContain("leaked-value");
    expect(prompter.shown.join("\n")).not.toContain("hooks.slack.com");
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
    ...SCHEDULE_ANSWERS,
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
      ON_ACTIONS,
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

  it("offers the named businesses as searches on the news sites, and keeps a proposed query's sites", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({ ...BASE_ROUTES, [TAVILY]: reply.json({ results: [] }) });
    const from = await writeProposal({
      ...PROPOSAL,
      repos: [],
      sites: [],
      queries: [{ query: "ペット保険 グッズ", topic: "general", evidence: "knowledge", includeDomains: ["prtimes.jp"] }],
    });
    const configDir = join(dir, "config");
    const picked = ["ペット葬儀社", "ペット保険 グッズ"];
    const { prompter, deps: d } = deps(
      [...PROPOSAL_CONTEXT, "repo", "vercel/next.js", "done", ["ペット葬儀社"], ["ペット保険 グッズ"], false, true, true, ON_ACTIONS],
      { env: { TAVILY_API_KEY: "tvly-test" } },
    );
    await runInit({ configDir, from, watch: { competitors: ["SUZURI"], adopters: ["ペット葬儀社"], newsSites: ["prtimes.jp"] } }, d);
    // The names are free news searches on the news sites; the proposal's general query is a web search.
    expect(prompter.options[NEWS]).toEqual(["SUZURI", "ペット葬儀社"]);
    expect(prompter.initial[NEWS]).toEqual([]);
    expect(prompter.options[WEB]).toEqual(["ペット保険 グッズ"]);
    const { feeds, queries } = (await loadConfig({ configDir, env: {} })).sources;
    expect(feeds.filter((f) => f.type === "googlenews")).toEqual([
      { id: queryIdFrom("ペット葬儀社", new Set()), type: "googlenews", query: "ペット葬儀社", sites: ["prtimes.jp"], locale: "ja-JP" },
    ]);
    expect(queries.map((q) => [q.query, q.topic, q.includeDomains])).toEqual([["ペット保険 グッズ", "general", ["prtimes.jp"]]]);
  });

  it("offers the proposal's general queries as web searches in place of Claude's", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({
      ...BASE_ROUTES,
      [TAVILY]: reply.text(await readFile(TAVILY_FIXTURE, "utf8")),
    });
    const llm = fakeLlm({ queries: () => ["from Claude"] });
    const from = await writeProposal({ ...PROPOSAL, repos: [], sites: [] });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps(
      [...PROPOSAL_CONTEXT, "repo", "vercel/next.js", "done", ["pet AI illustration app"], false, ON_ACTIONS],
      // The fetch reads process.env; init reads the env it is given.
      { resolveLlm: llm.resolve, env: { TAVILY_API_KEY: "tvly-test" } },
    );
    await runInit({ configDir, from }, d);
    expect(llm.calls).toEqual([]);
    expect(prompter.options[WEB]).toEqual(["pet AI illustration app"]);
    // Each costs a credit on every run, so none is picked for the user.
    expect(prompter.initial[WEB]).toBeUndefined();
    expect(prompter.asked).not.toContain(NEWS);
    expect((await loadConfig({ configDir, env: {} })).sources.queries).toEqual([
      { id: "pet-ai-illustration-app", query: "pet AI illustration app", topic: "general", maxResults: 10, requireDate: false },
    ]);
  });

  it("leaves a language it does not list to Other, filled in", async () => {
    const from = await writeProposal({ pochi: "proposal/v1", language: "Swahili", problems: [{ text: "News" }] });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps(["app", "", ["News"], false, "", "other", "Swahili", ["slack"], ...SCHEDULE_ANSWERS, false, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir, from }, d);
    expect(prompter.initial["Language for the summaries"]).toBe("other");
    expect(prompter.initial.Language).toBe("Swahili");
    // Nothing proposed for exclude, so it is asked as before.
    expect(prompter.asked).toContain("What should be dropped even if it looks related? (1/30, empty to finish)");
    expect((await loadConfig({ configDir, env: {} })).context.language).toBe("Swahili");
  });

  it("picks the listed language a proposal names by another name", async () => {
    const from = await writeProposal({ pochi: "proposal/v1", language: "中文", problems: [{ text: "News" }] });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps(["app", "", ["News"], false, "", "Chinese (Simplified)", ["slack"], ...SCHEDULE_ANSWERS, false, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir, from }, d);
    expect(prompter.initial["Language for the summaries"]).toBe("Chinese (Simplified)");
    expect((await loadConfig({ configDir, env: {} })).context.language).toBe("Chinese (Simplified)");
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
    const { prompter, deps: d } = deps([...answers, ["vercel/next.js"], [], "done", ON_ACTIONS]);
    await runInit({ configDir, from }, d);
    expect(prompter.asked).toContain("What do you want to hear about? (1/48, empty to finish)");
    expect((await loadConfig({ configDir, env: {} })).context.problems).toEqual([
      "Next.js breaking changes",
      "Competing pet illustration apps",
      "Supabase outages",
    ]);
  });

  it("warns about the entries it left out", async () => {
    const from = await writeProposal({ pochi: "proposal/v1", problems: [{ text: "News" }], repos: [{ repo: "nope" }, "x"] });
    const { prompter, deps: d } = deps(["app", "", ["News"], false, "", "English", ["slack"], ...SCHEDULE_ANSWERS, false, ...SOURCE_ANSWERS, ON_ACTIONS]);
    await runInit({ configDir: join(dir, "config"), from }, d);
    expect(prompter.shown).toContain("warn: Left out 2 proposed entries: malformed or past the limits.");
  });

  it("does not wait for Claude when the proposal answers every step that needs it", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    let lookup: AbortSignal | undefined;
    const from = await writeProposal(PROPOSAL);
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, ["vercel/next.js"], [SIMON], "done", [], false, ON_ACTIONS], {
      env: { TAVILY_API_KEY: "tvly-test" },
      // Never settles, like a CLI probe that hangs.
      resolveLlm: (_, opts) => {
        lookup = opts?.signal;
        return new Promise(() => {});
      },
    });
    await runInit({ configDir: join(dir, "config"), from }, d);
    expect(prompter.asked).toContain(WEB);
    expect(prompter.shown.some((s) => s.includes("Looking for Claude"))).toBe(false);
    expect(lookup?.aborted).toBe(true);
  });

  it("drops proposed queries that clean to nothing or repeat, and names non-ASCII ones by a hash", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    mockFetch({
      ...BASE_ROUTES,
      [TAVILY]: reply.text(await readFile(TAVILY_FIXTURE, "utf8")),
    });
    const from = await writeProposal({
      ...PROPOSAL,
      repos: [],
      sites: [],
      queries: [{ query: "\u0007" }, { query: "Pet  AI" }, { query: "pet ai" }, { query: "ペット イラスト" }],
    });
    const configDir = join(dir, "config");
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, "done", ["Pet AI", "ペット イラスト"], "", true, true, ON_ACTIONS], {
      env: { TAVILY_API_KEY: "tvly-test" },
    });
    await runInit({ configDir, from }, d);
    // Without a topic they are news, so free news searches, picked to begin with as proposed.
    expect(prompter.options[NEWS]).toEqual(["Pet AI", "ペット イラスト"]);
    expect(prompter.initial[NEWS]).toEqual(["Pet AI", "ペット イラスト"]);
    const ids = (await loadConfig({ configDir, env: {} })).sources.feeds.map((f) => f.id);
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
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, [blog, SIMON], "done", ON_ACTIONS]);
    await runInit({ configDir, from }, d);
    expect(prompter.shown).toContain("spin: Looking for feeds on 2 sites");
    expect(prompter.shown).toContain("warn: Already added: simonwillison.net/atom/everything; skipped.");
    expect((await loadConfig({ configDir, env: {} })).sources.feeds).toEqual([expect.objectContaining({ url: SIMON })]);
  });

  it("leaves out a proposed site it could not check instead of offering to add it anyway", async () => {
    const down = "https://down.example.com/";
    mockFetch({ ...BASE_ROUTES, [down]: reply.status(503) });
    const from = await writeProposal({ ...PROPOSAL, repos: [], sites: [{ url: down }, { url: SIMON }] });
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, [down, SIMON], "done", ON_ACTIONS]);
    await runInit({ configDir: join(dir, "config"), from }, d);
    expect(prompter.shown.some((s) => s.startsWith(`warn: Could not open ${down}`) && s.endsWith("; left out"))).toBe(true);
    expect(prompter.asked.some((m) => m.includes("anyway"))).toBe(false);
  });

  it("says the proposed queries are left out without a Tavily key", async () => {
    const from = await writeProposal(PROPOSAL);
    const { prompter, deps: d } = deps([...PROPOSAL_CONTEXT, ["vercel/next.js"], [], "done", ON_ACTIONS]);
    await runInit({ configDir: join(dir, "config"), from }, d);
    expect(prompter.shown).toContain(
      "note: TAVILY_API_KEY is not set, so web searches are skipped (1 proposed web search left out).",
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

  it("adds who to follow, cleaned, and refuses a news site that is not a domain before printing", async () => {
    let out = "";
    const { deps: d } = deps([], { isInteractive: () => false, stdout: (s) => (out += s) });
    const watch = { adopters: ["  ペット葬儀社 ", "ペット葬儀社", ""], newsSites: ["PRTimes.jp"] };
    await runInit({ printPrompt: true, watch }, d);
    expect(out).toContain('like this one: "ペット葬儀社". Add a problem');
    expect(out).toContain('news: "prtimes.jp"');
    out = "";
    const err = await rejection(runInit({ printPrompt: true, watch: { newsSites: ["prtimes.jp/news"] } }, d));
    expect(err).toBeInstanceOf(ConfigError);
    expect(out).toBe("");
  });

  it("cannot be combined with --from", async () => {
    const { deps: d } = deps([], { stdout: () => undefined });
    expect(await rejection(runInit({ printPrompt: true, from: "x.json" }, d))).toBeInstanceOf(ConfigError);
  });
});
