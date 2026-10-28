import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DoctorDeps, type DoctorOptions, doctor, doctorCommand } from "../../src/commands/doctor.js";
import { ExitCode } from "../../src/errors.js";
import { inspectState } from "../../src/state/store.js";
import { configureLog, resetLog } from "../../src/util/log.js";
import { fakeSpawn, run } from "../helpers/fakeSpawn.js";
import { mockFetch, reply } from "../helpers/mockFetch.js";

vi.mock("../../src/state/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/store.js")>();
  return { ...actual, inspectState: vi.fn(actual.inspectState) };
});

const CLAUDE_VERSION = "2.1.310 (Claude Code)";
const RELEASES = "https://api.github.com/repos/vercel/next.js/releases?per_page=100";
const FEED = "https://blog.example.com/feed.xml";
const SEARCH = "https://api.tavily.com/search";
const ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "TAVILY_API_KEY",
  "SLACK_WEBHOOK_URL",
  "GITHUB_TOKEN",
  "POCHI_CONTEXT_YAML",
  "POCHI_SOURCES_YAML",
  "POCHI_STATE_PATH",
];

const CONTEXT = `version: 1
project: { name: my-app, description: "A SaaS app" }
problems: ["Breaking changes in Next.js"]
state: { ttlDays: 45, maxItemAgeDays: 14 }
`;

const SOURCES = `version: 1
feeds:
  - { id: nextjs, type: github, name: "Next.js releases", repo: vercel/next.js }
  - { id: blog, type: rss, name: "A blog", url: "${FEED}" }
queries:
  - { id: qwen, query: "Qwen model release" }
`;

const release = (tag: string, published: string) => ({
  html_url: `https://github.com/vercel/next.js/releases/tag/${tag}`,
  tag_name: tag,
  name: tag,
  draft: false,
  prerelease: false,
  published_at: published,
  body_html: `<p>${tag}</p>`,
});

const rss = (...titles: string[]) =>
  reply.text(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${titles
      .map((t, i) => `<item><title>${t}</title><link>https://blog.example.com/${i}</link></item>`)
      .join("")}</channel></rss>`,
  );

let dir: string;
let out: string[];
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pochi-doctor-"));
  await writeFile(join(dir, "context.yml"), CONTEXT);
  await writeFile(join(dir, "sources.yml"), SOURCES);
  for (const name of ENV_NAMES) vi.stubEnv(name, undefined);
  out = [];
  logs = [];
  configureLog({ write: (s) => logs.push(s) });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetLog();
  await rm(dir, { recursive: true, force: true });
});

function check(opts: DoctorOptions = {}, deps: DoctorDeps = {}) {
  return doctor(
    { configDir: dir, state: join(dir, "notified.json"), ...opts },
    { platform: "darwin", spawn: fakeSpawn(run.exit(`${CLAUDE_VERSION}\n`)).spawn, write: (l) => out.push(l), ...deps },
  );
}

const line = (label: string) => out.find((l) => l.trimStart().split(/\s+/)[1] === label);

describe("doctor: secrets", () => {
  // Values without a known prefix and under redact()'s 8-character fallback are not masked by the
  // logger, so their absence shows doctor never printed them in the first place.
  const SECRETS = {
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T0001/B0001/w3bh00kS3cret",
    TAVILY_API_KEY: "tv7k3y",
    ANTHROPIC_API_KEY: "sk-ant-api03-an7hr0p1cS3cret",
    GITHUB_TOKEN: "gh7ok",
    ANTHROPIC_BASE_URL: "https://user:pa55w0rd@gateway.example.com",
  };
  const CONFIG_MARKER = "C0nf1gMarker";

  function expectNoSecrets() {
    const text = [...out, ...logs].join("\n");
    for (const value of [...Object.values(SECRETS), "pa55w0rd", "w3bh00kS3cret", CONFIG_MARKER]) {
      expect(text).not.toContain(value);
      expect(text).not.toContain(encodeURIComponent(value));
    }
    // Nothing had to be masked either: doctor never tried to print a secret.
    expect(text).not.toContain("***");
  }

  beforeEach(() => {
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
    vi.stubEnv("POCHI_CONTEXT_YAML", CONTEXT.replace("A SaaS app", CONFIG_MARKER));
    vi.stubEnv("POCHI_SOURCES_YAML", SOURCES);
  });

  it("prints none in a healthy run with --fetch", async () => {
    mockFetch({
      [RELEASES]: reply.json([release("v16.1.0", "2026-10-20T00:00:00Z")]),
      [FEED]: rss("Hello"),
      [SEARCH]: reply.json({ results: [{ title: "Qwen 4", url: "https://news.example.com/q", content: "c" }] }),
    });
    const result = await check({ fetch: true });
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(line("TAVILY_API_KEY")).toMatch(/ok\s+TAVILY_API_KEY\s+set$/);
    expect(line("SLACK_WEBHOOK_URL")).toMatch(/ok\s+SLACK_WEBHOOK_URL\s+set$/);
    expect(line("slack")).toMatch(/ok\s+slack\s+posts to SLACK_WEBHOOK_URL$/);
    expectNoSecrets();
  });

  it("prints none when every source fails", async () => {
    mockFetch({
      [RELEASES]: reply.status(404),
      [FEED]: reply.text("not a feed"),
      [SEARCH]: reply.status(401),
    });
    const result = await check({ fetch: true });
    expect(result.exitCode).toBe(ExitCode.SOURCES);
    expect(line("qwen")).toMatch(/fail\s+qwen \(tavily\)\s+.*TAVILY_API_KEY/);
    expectNoSecrets();
  });

  it("prints none when the config is invalid, even a secret placed in a field", async () => {
    vi.stubEnv("POCHI_CONTEXT_YAML", CONTEXT.replace("my-app", `[${SECRETS.TAVILY_API_KEY}]`));
    vi.stubEnv("POCHI_SOURCES_YAML", `${SOURCES}  - { id: x, query: "${SECRETS.GITHUB_TOKEN}", bad: ${CONFIG_MARKER} }\n`);
    const result = await check();
    expect(result.exitCode).toBe(ExitCode.CONFIG);
    expect(out.filter((l) => /fail\s+config/.test(l))).toHaveLength(1);
    expectNoSecrets();
  });

  it("prints none when the LLM cannot be used or the state file is broken", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    await writeFile(join(dir, "notified.json"), JSON.stringify({ version: 1, entries: SECRETS }));
    const result = await check({}, { spawn: fakeSpawn(run.spawnError("ENOENT")).spawn });
    expect(result.exitCode).toBe(ExitCode.LLM);
    expectNoSecrets();
  });
});

describe("doctor: config", () => {
  it("shows where each file came from and what it holds", async () => {
    vi.stubEnv("POCHI_SOURCES_YAML", SOURCES);
    vi.stubEnv("TAVILY_API_KEY", "tvly-0123456789");
    const result = await check();
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(line("context")).toContain(`${join(dir, "context.yml")} (project my-app)`);
    expect(line("sources")).toContain("env POCHI_SOURCES_YAML (2 feeds, 1 query)");
  });

  it("fails with 2 and skips the LLM when the config is invalid", async () => {
    await rm(join(dir, "sources.yml"));
    const spawn = fakeSpawn([]);
    const result = await check({ fetch: true }, { spawn: spawn.spawn });
    expect(result.exitCode).toBe(ExitCode.CONFIG);
    expect(line("config")).toMatch(/sources\.yml not found/);
    expect(line("llm")).toMatch(/skip\s+llm\s+config is invalid/);
    expect(line("sources")).toMatch(/skip\s+sources\s+config is invalid/);
    expect(spawn.calls).toHaveLength(0);
  });

  it("counts a file with several issues as one problem, shown one issue per line", async () => {
    await writeFile(join(dir, "sources.yml"), "version: 1\nfeeds:\n  - { id: a, type: rss }\n  - { id: b, type: rss }\n");
    const result = await check({}, { spawn: fakeSpawn([]).spawn });
    expect(result.exitCode).toBe(ExitCode.CONFIG);
    expect(result.checks.filter((c) => c.section === "Config")).toHaveLength(1);
    const start = out.findIndex((l) => /fail\s+config/.test(l));
    expect(out[start + 1]).toMatch(/^\s{29}\S/);
    expect(out.at(-1)).toMatch(/^1 problem found\b/);
  });

  it("warns about queries skipped without TAVILY_API_KEY", async () => {
    const result = await check();
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(line("queries")).toMatch(/warn\s+queries\s+1 query skipped without TAVILY_API_KEY/);
  });

  it("fails with 2 when only queries are configured and there is no Tavily key", async () => {
    await writeFile(join(dir, "sources.yml"), `version: 1\nqueries:\n  - { id: q, query: "x" }\n`);
    const result = await check();
    expect(result.exitCode).toBe(ExitCode.CONFIG);
    expect(line("queries")).toMatch(/fail\s+queries\s+no feeds/);
  });
});

describe("doctor: LLM", () => {
  it("reports the API mode without starting claude or calling the API", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-0123456789");
    const fm = mockFetch({});
    const spawn = fakeSpawn([]);
    await check({}, { spawn: spawn.spawn });
    expect(line("api")).toMatch(/ok\s+api mode\s+triage claude-haiku-5-5 · analyze claude-sonnet-5-5/);
    expect(spawn.calls).toHaveLength(0);
    expect(fm.calls).toHaveLength(0);
  });

  it("reports the CLI mode with what claude --version printed", async () => {
    await check();
    expect(line("cli")).toMatch(new RegExp(`ok\\s+cli mode\\s+${CLAUDE_VERSION.replace(/[()]/g, "\\$&")} · triage haiku · analyze sonnet`));
  });

  it("reads the state file while claude --version runs, and still reports it after the LLM", async () => {
    vi.mocked(inspectState).mockClear();
    let readsAtProbe = -1;
    const spawn = fakeSpawn((child) => {
      readsAtProbe = vi.mocked(inspectState).mock.calls.length;
      run.exit(`${CLAUDE_VERSION}\n`)(child);
    });
    await check({}, { spawn: spawn.spawn });
    expect(readsAtProbe).toBe(1);
    expect(out.indexOf("LLM")).toBeLessThan(out.indexOf("State"));
  });

  it("fails with 3 when neither mode is usable, and keeps checking the rest", async () => {
    const result = await check({}, { spawn: fakeSpawn(run.exit("", { code: 1 })).spawn });
    expect(result.exitCode).toBe(ExitCode.LLM);
    expect(line("llm")).toMatch(/fail\s+llm\s+unavailable: no LLM available/);
    expect(out).toContain("State");
  });

  it("fails with 3 on Windows without a key", async () => {
    const result = await check({}, { platform: "win32" });
    expect(result.exitCode).toBe(ExitCode.LLM);
    expect(line("llm")).toMatch(/not supported on Windows/);
  });
});

describe("doctor: environment", () => {
  it("shows set, not set and blank", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_0123456789");
    vi.stubEnv("TAVILY_API_KEY", "  ");
    await check();
    expect(line("GITHUB_TOKEN")).toMatch(/ok\s+GITHUB_TOKEN\s+set$/);
    expect(line("TAVILY_API_KEY")).toMatch(/warn\s+TAVILY_API_KEY\s+blank \(treated as unset\)/);
    expect(line("ANTHROPIC_BASE_URL")).toMatch(/-\s+ANTHROPIC_BASE_URL\s+not set/);
    expect(line("SLACK_WEBHOOK_URL")).toMatch(/-\s+SLACK_WEBHOOK_URL\s+not set/);
  });
});

describe("doctor: notify", () => {
  const withChannels = (channels: string) => writeFile(join(dir, "context.yml"), `${CONTEXT}notify: { channels: ${channels} }\n`);

  it("warns about the webhook only when Slack is a channel", async () => {
    await check();
    expect(line("slack")).toMatch(/warn\s+slack\s+SLACK_WEBHOOK_URL is not set/);

    out = [];
    vi.stubEnv("SLACK_WEBHOOK_URL", "https://example.com/hook");
    expect((await check()).exitCode).toBe(ExitCode.OK);
    expect(line("slack")).toMatch(/warn\s+slack\s+SLACK_WEBHOOK_URL is not a https:\/\/hooks\.slack\.com\/ URL/);

    out = [];
    vi.stubEnv("SLACK_WEBHOOK_URL", undefined);
    await withChannels(`[{ type: file, dir: "${join(dir, "reports")}" }]`);
    await check();
    expect(line("slack")).toBeUndefined();
    expect(out.filter((l) => l.includes("warn") && l.includes("SLACK"))).toEqual([]);
  });

  it("accepts a report directory that exists or can be created", async () => {
    await withChannels(`[{ type: file, dir: "${join(dir, "a", "b")}" }]`);
    expect((await check()).exitCode).toBe(ExitCode.OK);
    expect(line("file")).toMatch(/ok\s+file\s+writes .*\/a\/b\/<date>\.md/);
  });

  it("fails with 4 when the report directory is a file", async () => {
    await writeFile(join(dir, "taken"), "");
    await withChannels(`[{ type: file, dir: "${join(dir, "taken")}" }]`);
    const result = await check();
    expect(result.exitCode).toBe(ExitCode.DELIVERY);
    expect(line("file")).toMatch(/fail\s+file\s+.*taken: not a directory/);
  });
});

describe("doctor: state", () => {
  const key = (n: number) => n.toString(16).padStart(32, "0");
  const statePath = () => join(dir, "notified.json");

  it("is fine without a state file", async () => {
    const result = await check();
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(line(statePath())).toMatch(/ok\s+\S+\s+not found/);
  });

  it("counts entries by status and those past ttlDays", async () => {
    const entries = {
      [key(1)]: { s: "n", f: "2026-10-01", l: "2026-10-25" },
      [key(2)]: { s: "i", f: "2026-08-01", l: "2026-08-01" },
      [key(3)]: { s: "r", f: "2026-10-25", l: "2026-10-25" },
      [key(4)]: { s: "i", f: "2026-10-25", l: "2026-10-25" },
    };
    await writeFile(statePath(), JSON.stringify({ version: 1, entries }));
    await check({}, { now: new Date("2026-10-26T00:00:00Z") });
    expect(line(statePath())).toContain("4 entries (n 1 · i 2 · r 1), 1 past ttlDays (45)");
  });

  it("fails with 1 on a corrupt file and leaves it in place", async () => {
    await writeFile(statePath(), "{ not json");
    const result = await check();
    expect(result.exitCode).toBe(ExitCode.INTERNAL);
    expect(line(statePath())).toMatch(/fail\s+\S+\s+not a valid state file/);
    expect(await readFile(statePath(), "utf8")).toBe("{ not json");
    expect(await readdir(dir)).not.toContainEqual(expect.stringContaining("corrupt"));
  });

  it("warns about invalid entries", async () => {
    await writeFile(statePath(), JSON.stringify({ version: 1, entries: { bad: { s: "n" }, [key(1)]: { s: "n", f: "2026-10-01", l: "2026-10-01" } } }));
    const result = await check();
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(out.find((l) => l.includes("1 invalid entry"))).toMatch(/^\s+warn/);
  });

  it("takes --state over POCHI_STATE_PATH", async () => {
    vi.stubEnv("POCHI_STATE_PATH", join(dir, "from-env.json"));
    await check({ state: join(dir, "from-flag.json") });
    expect(line(join(dir, "from-flag.json"))).toBeDefined();
    await check({ state: undefined });
    expect(line(join(dir, "from-env.json"))).toBeDefined();
  });
});

describe("doctor: --fetch", () => {
  beforeEach(() => vi.stubEnv("TAVILY_API_KEY", "tvly-0123456789"));

  it("shows each source's latest title in config order", async () => {
    mockFetch({
      [RELEASES]: reply.json([release("v16.0.0", "2026-10-01T00:00:00Z"), release("v16.1.0", "2026-10-20T00:00:00Z")]),
      [FEED]: rss("Newest", "Older"),
      [SEARCH]: reply.json({ results: [] }),
    });
    const result = await check({ fetch: true });
    expect(result.exitCode).toBe(ExitCode.OK);
    const sources = out.slice(out.indexOf("Sources (--fetch)") + 1, out.indexOf(""));
    expect(sources).toEqual([
      expect.stringMatching(/ok\s+nextjs \(github\)\s+v16\.1\.0$/),
      expect.stringMatching(/ok\s+blog \(rss\)\s+Newest$/),
      expect.stringMatching(/warn\s+qwen \(tavily\)\s+no items$/),
    ]);
  });

  it("does not fetch without --fetch", async () => {
    const fm = mockFetch({});
    await check();
    expect(fm.calls).toHaveLength(0);
    expect(out).not.toContain("Sources (--fetch)");
  });

  it("keeps 0 when some sources fail", async () => {
    mockFetch({ [RELEASES]: reply.status(404), [FEED]: rss("Hello"), [SEARCH]: reply.json({ results: [] }) });
    const result = await check({ fetch: true });
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(line("nextjs")).toMatch(/fail\s+nextjs \(github\)\s+.*404/);
    // Counted as what it is, not as a warning; the warnings are SLACK_WEBHOOK_URL and the empty query.
    expect(out.at(-1)).toBe("No problems found, 1 non-fatal failure, 2 warnings");
  });

  it("strips terminal escape sequences from titles and caps their length", async () => {
    const evil = "\u001b]8;;https://evil.example/\u0007click\u001b]8;;\u0007 \u001b[2J\u009b31mred";
    mockFetch({
      [RELEASES]: reply.json([{ ...release("v1", "2026-10-20T00:00:00Z"), name: evil }]),
      [FEED]: rss("x".repeat(500)),
      [SEARCH]: reply.json({ results: [] }),
    });
    await check({ fetch: true });
    expect(out.join("\n")).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(line("nextjs")).toMatch(/click/);
    const detail = line("blog")!.split(/\s+/).at(-1)!;
    expect(detail).toMatch(/…$/);
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  it("skips queries without a Tavily key", async () => {
    vi.stubEnv("TAVILY_API_KEY", undefined);
    const fm = mockFetch({ [RELEASES]: reply.json([]), [FEED]: rss("Hello") });
    await check({ fetch: true });
    expect(line("qwen")).toMatch(/skip\s+qwen \(tavily\)\s+TAVILY_API_KEY is not set/);
    expect(fm.callsTo(SEARCH)).toHaveLength(0);
  });

  it("fetches at most 4 sources at a time", async () => {
    const feeds = Array.from({ length: 6 }, (_, i) => `  - { id: f${i}, type: rss, name: F${i}, url: "https://f${i}.example.com/" }`);
    await writeFile(join(dir, "sources.yml"), `version: 1\nfeeds:\n${feeds.join("\n")}\n`);
    let active = 0;
    let peak = 0;
    const slow = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return rss("x")({} as never, undefined);
    };
    mockFetch(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`https://f${i}.example.com/`, slow])));
    await check({ fetch: true });
    expect(peak).toBe(4);
  });

  it("returns 130 when interrupted, without reporting the sources", async () => {
    const controller = new AbortController();
    const fm = mockFetch({ [RELEASES]: reply.hang(), [FEED]: reply.hang(), [SEARCH]: reply.hang() });
    const pending = check({ fetch: true }, { signal: controller.signal });
    await vi.waitFor(() => expect(fm.calls.length).toBeGreaterThan(0));
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(ExitCode.INTERRUPTED);
    expect(out).not.toContain("Sources (--fetch)");
  });

  it("returns 130 when interrupted outside the probe and the fetches, without the closing line", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await check({}, { signal: controller.signal });
    expect(result.exitCode).toBe(ExitCode.INTERRUPTED);
    expect(out.some((l) => /problems? found/.test(l))).toBe(false);
  });
});

describe("doctorCommand", () => {
  it("throws the exit code of the first problem", async () => {
    await rm(join(dir, "context.yml"));
    const command = doctorCommand({ write: (l) => out.push(l), spawn: fakeSpawn([]).spawn }).exitOverride();
    await expect(command.parseAsync(["--config-dir", dir], { from: "user" })).rejects.toMatchObject({
      exitCode: ExitCode.CONFIG,
      message: "doctor: 1 problem found",
    });
  });

  it("uses the signal it is given instead of listening for SIGINT itself", async () => {
    const before = process.listenerCount("SIGINT");
    let during = -1;
    const spawn = fakeSpawn((child) => {
      during = process.listenerCount("SIGINT");
      run.exit(`${CLAUDE_VERSION}\n`)(child);
    });
    const command = doctorCommand({ write: (l) => out.push(l), spawn: spawn.spawn, signal: new AbortController().signal });
    await command.exitOverride().parseAsync(["--config-dir", dir, "--state", join(dir, "notified.json")], { from: "user" });
    expect(during).toBe(before);
  });

  it("puts the log level back afterwards", async () => {
    const command = doctorCommand({ write: (l) => out.push(l) }).exitOverride();
    await command.parseAsync(["--config-dir", dir, "--state", join(dir, "notified.json")], { from: "user" });
    logs.length = 0;
    const { log } = await import("../../src/util/log.js");
    log.info("after doctor");
    expect(logs).toEqual(["pochi: info: after doctor\n"]);
  });
});
