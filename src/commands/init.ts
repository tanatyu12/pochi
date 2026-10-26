import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigError, DEFAULT_CONFIG_DIR } from "../config/load.js";
import { type ContextInput, REPO_PATTERN, type SourcesInput } from "../config/schema.js";
import { existingConfig, writeConfig } from "../config/write.js";
import { normalizeUrl, parseHttpUrl } from "../util/hash.js";
import { type Prompter, PromptCancelled, createClackPrompter } from "../util/prompter.js";

const MAX_PROBLEMS = 20;
const MAX_EXCLUDE = 30;

export interface InitDeps {
  prompter: Prompter;
  isInteractive: () => boolean;
  /**
   * For each path (all in one directory): true or false when git can tell, undefined when it
   * cannot (no git, not a repository).
   */
  checkIgnored: (paths: string[]) => Promise<(boolean | undefined)[]>;
  env: NodeJS.ProcessEnv;
}

type FeedInput = NonNullable<SourcesInput["feeds"]>[number];

export async function runInit(opts: { configDir?: string } = {}, deps: Partial<InitDeps> = {}): Promise<void> {
  const isInteractive = deps.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  // Checked before anything is shown: a piped or CI run would otherwise hang on the first question.
  if (!isInteractive()) {
    throw new ConfigError("pochi init needs an interactive terminal; copy config/*.example.yml instead");
  }
  const p = deps.prompter ?? createClackPrompter();
  const checkIgnored = deps.checkIgnored ?? gitCheckIgnored;
  const env = deps.env ?? process.env;
  const dir = opts.configDir ?? DEFAULT_CONFIG_DIR;

  p.intro("pochi init");
  // Asked first so nobody answers every question only to be refused at the end.
  const existing = await existingConfig(dir);
  if (existing.length > 0) {
    const overwrite = await p.confirm({ message: `Overwrite ${existing.join(" and ")}?`, initialValue: false });
    if (!overwrite) throw new PromptCancelled();
  }

  const context = await askContext(p);
  const sources = await askSources(p);
  // Nothing touches the disk until every answer is in, so a cancel above leaves no trace.
  const { contextPath, sourcesPath } = await writeConfig(dir, { context, sources }, { overwrite: true });

  const paths = [contextPath, sourcesPath];
  const ignored = await checkIgnored(paths);
  paths.forEach((path, i) => {
    if (ignored[i] === false) {
      p.warn(`${path} is not ignored by git; add ${join(dir, "*.yml")} to .gitignore before committing.`);
    }
    if (ignored[i] === undefined) p.note(`Could not check whether git ignores ${path}.`);
  });
  for (const name of ["POCHI_CONTEXT_YAML", "POCHI_SOURCES_YAML"]) {
    if (env[name]?.trim()) p.warn(`${name} is set and takes precedence over the files just written.`);
  }

  p.note(
    [
      `node dist/pochi.mjs run --dry-run${dir === DEFAULT_CONFIG_DIR ? "" : ` --config-dir ${shellQuote(dir)}`}`,
      `gh secret set POCHI_CONTEXT_YAML < ${shellQuote(contextPath)}`,
      `gh secret set POCHI_SOURCES_YAML < ${shellQuote(sourcesPath)}`,
      `gh secret set SLACK_WEBHOOK_URL`,
      `gh secret set ANTHROPIC_API_KEY`,
    ].join("\n"),
    "Next steps",
  );
  p.outro(`Wrote ${contextPath} and ${sourcesPath}`);
}

async function askContext(p: Prompter): Promise<ContextInput> {
  const name = await p.text({ message: "Project name", placeholder: "my-app", validate: required });
  const description = await p.text({
    message: "Describe the project in a sentence or two (optional)",
    placeholder: "A Next.js SaaS app with a Postgres backend",
  });
  const problems = await askList(p, {
    message: "What do you want to hear about?",
    placeholder: "Breaking changes in Next.js",
    min: 1,
    max: MAX_PROBLEMS,
  });
  const exclude = await askList(p, {
    message: "What should be dropped even if it looks related?",
    placeholder: "Funding news",
    min: 0,
    max: MAX_EXCLUDE,
  });
  const choice = await p.select({
    message: "Language for the summaries",
    options: [
      { value: "English", label: "English" },
      { value: "Japanese", label: "Japanese" },
      { value: "other", label: "Other" },
    ],
    initialValue: "English",
  });
  const language =
    choice === "other" ? (await p.text({ message: "Language", placeholder: "German", validate: required })).trim() : choice;

  return {
    version: 1,
    project: { name: name.trim(), description: description.trim() },
    problems,
    ...(exclude.length > 0 && { exclude }),
    language,
  };
}

// One text prompt per entry; an empty answer ends the list once min entries are in.
async function askList(
  p: Prompter,
  opts: { message: string; placeholder: string; min: number; max: number },
): Promise<string[]> {
  const items: string[] = [];
  while (items.length < opts.max) {
    const mandatory = items.length < opts.min;
    const answer = await p.text({
      message: `${opts.message} (${items.length + 1}/${opts.max}${mandatory ? "" : ", empty to finish"})`,
      placeholder: opts.placeholder,
      validate: mandatory ? required : undefined,
    });
    if (answer.trim() === "") break;
    items.push(answer.trim());
  }
  return items;
}

/** Minimal source entry: the repo or feed URL is taken as typed, without checking it exists. */
export async function askSources(p: Prompter): Promise<SourcesInput> {
  const feeds: FeedInput[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (;;) {
    const kind = await p.select({
      message: feeds.length === 0 ? "Add a source to watch" : `Add another source? (${feeds.length} so far)`,
      options: [
        { value: "github", label: "GitHub repository", hint: "owner/repo" },
        { value: "rss", label: "RSS / Atom feed", hint: "feed URL" },
        // sources.yml needs at least one source.
        ...(feeds.length > 0 ? [{ value: "done" as const, label: "Done" }] : []),
      ],
    });
    if (kind === "done") break;

    const feed = kind === "github" ? await askRepo(p, ids) : await askFeedUrl(p, ids);
    // An empty answer backs out to the choice above.
    if (!feed) continue;
    // GitHub treats owner/repo case-insensitively; feed URLs compare as the pipeline dedupes them.
    const key = feed.type === "github" ? `github:${feed.repo.toLowerCase()}` : `rss:${normalizeUrl(feed.url)}`;
    if (keys.has(key)) {
      p.warn("Already added; skipped.");
      continue;
    }
    keys.add(key);
    ids.add(feed.id);
    feeds.push(feed);
  }
  return { version: 1, feeds };
}

async function askRepo(p: Prompter, ids: ReadonlySet<string>): Promise<FeedInput | undefined> {
  const repo = (
    await p.text({
      message: "GitHub repository (empty to go back)",
      placeholder: "vercel/next.js",
      validate: (v) => (v.trim() === "" || REPO_PATTERN.test(v.trim()) ? undefined : "Enter it as owner/repo"),
    })
  ).trim();
  if (repo === "") return undefined;
  return { id: sourceIdFrom(repo.split("/")[1]!, ids), type: "github", name: repo, repo };
}

async function askFeedUrl(p: Prompter, ids: ReadonlySet<string>): Promise<FeedInput | undefined> {
  const raw = (
    await p.text({
      message: "Feed URL (empty to go back)",
      placeholder: "https://simonwillison.net/atom/everything/",
      validate: (v) => (v.trim() === "" || parseHttpUrl(v.trim()) ? undefined : "Enter an absolute http(s) URL"),
    })
  ).trim();
  if (raw === "") return undefined;
  const url = parseHttpUrl(raw)!;
  const host = url.hostname.replace(/^www\./, "");
  return { id: sourceIdFrom(host, ids), type: "rss", name: host, url: url.href };
}

/** Turns a repo or host name into a source id that is not in taken. */
export function sourceIdFrom(raw: string, taken: ReadonlySet<string>): string {
  const base =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+$/, "") || "source";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function required(value: string): string | undefined {
  return value.trim() === "" ? "Required" : undefined;
}

/** Quotes a value for a POSIX shell, leaving plain paths as they are. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

// One git call for paths that share a directory. It runs in that directory so a --config-dir
// inside another repository is checked against that one.
export async function gitCheckIgnored(paths: string[]): Promise<(boolean | undefined)[]> {
  const names = paths.map((path) => basename(path));
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("git", ["check-ignore", "--", ...names], {
      cwd: dirname(resolve(paths[0]!)),
    }));
  } catch (err) {
    // 1 means none is ignored; anything else (128 outside a repository, ENOENT without git) means unknown.
    const { code, stdout: out } = err as { code?: unknown; stdout?: unknown };
    if (code !== 1) return paths.map(() => undefined);
    stdout = typeof out === "string" ? out : "";
  }
  // Prints the ignored ones among the names it was given, one per line as given
  // (the names are context.yml and sources.yml, so git has nothing to quote).
  const ignored = new Set(stdout.split("\n"));
  return names.map((name) => ignored.has(name));
}
