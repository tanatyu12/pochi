import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCron } from "../../src/schedule/calendar.js";
import { githubScheduler, WORKFLOW_PATH } from "../../src/schedule/github.js";
import { buildJob, type Job } from "../../src/schedule/index.js";

let job: Job;

beforeEach(async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pochi-github-"));
  job = buildJob({ cwd, scriptPath: join(cwd, "dist/pochi.mjs"), execPath: "/usr/bin/node", path: "" });
});

afterEach(async () => {
  await rm(job.cwd, { recursive: true, force: true });
});

describe("githubScheduler", () => {
  it("renders the workflow with the UTC cron and the summary", () => {
    expect(githubScheduler().render(job, parseCron("17 21 * * 0,3"), "weekly on Monday and Thursday at 06:17 (Asia/Tokyo)")).toMatchSnapshot();
  });

  it("keeps the token out of .git/config and dependency scripts, and gives it only to the push", () => {
    const yml = githubScheduler().render(job, parseCron("17 21 * * *"), "daily");
    expect(yml).toContain("persist-credentials: false");
    expect(yml).toContain("npm ci --ignore-scripts");
    const commitStep = yml.slice(yml.indexOf("- name: Commit the state file"));
    expect(commitStep).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(commitStep).toContain("GIT_CONFIG_VALUE_0=");
    expect(commitStep).not.toContain("git remote");
  });

  it("writes, inspects and removes the workflow file", async () => {
    const scheduler = githubScheduler();
    expect(await scheduler.inspect(job)).toEqual({ content: undefined });
    const notes = await scheduler.install(job, "name: Briefing\n");
    expect(await readFile(join(job.cwd, WORKFLOW_PATH), "utf8")).toBe("name: Briefing\n");
    expect(notes.join("\n")).toContain("gh secret set");
    expect(await scheduler.inspect(job)).toEqual({ content: "name: Briefing\n" });
    expect(await scheduler.uninstall(job)).toBe(true);
    expect(await scheduler.uninstall(job)).toBe(false);
  });
});
