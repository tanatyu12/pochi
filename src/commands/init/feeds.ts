import { REPO_PATTERN } from "../../config/schema.js";
import { MAX_REPO_CANDIDATES, queryId, repoInferenceRequest } from "../../llm/prompts.js";
import { type LlmClient, LlmError } from "../../llm/schema.js";
import type { Proposal } from "../../proposal/parse.js";
import { type DiscoveredFeed, FeedCheckError, discoverFeeds, isTransient } from "../../sources/discover.js";
import { type RepoCheck, verifyRepo } from "../../sources/github.js";
import { FeedParseError } from "../../sources/rss.js";
import { tavilyApiKey } from "../../sources/tavily.js";
import { pLimit } from "../../util/concurrency.js";
import { normalizeUrl, parseHttpUrl } from "../../util/hash.js";
import { HttpError } from "../../util/http.js";
import { displayLine, plural } from "../../util/text.js";
import { sourceIdFrom } from "./ids.js";
import { type FeedInput, feedKey, keyOf, labelOf, once, repoKey } from "./keys.js";
import { askNews, mayOfferNews } from "./searches.js";
import {
  HINT_MAX_CHARS,
  NONE,
  SHOWN_MAX_CHARS,
  type SourceSession,
  claim,
  errorLine,
  getLlm,
  llmFailed,
  settle,
  throwIfCancelled,
} from "./session.js";

// Each check is one or two GitHub API calls; a proposal can name 15 repositories at once.
const GITHUB_CONCURRENCY = 4;
// Each looks at one page and the feeds it leads to; a proposal can name 8 sites.
const SITE_CONCURRENCY = 4;

type FoundRepo = Extract<RepoCheck, { status: "found" }>;

/** The sources menu: repositories, sites and news searches, one at a time until Done. */
export async function askFeeds(s: SourceSession, added: FeedInput[] = []): Promise<FeedInput[]> {
  for (;;) {
    const count = s.feeds.length + added.length;
    const kind = await s.p.select({
      message: count === 0 ? "Add a source to watch" : `Add another source? (${count} so far)`,
      options: [
        {
          value: "repo",
          label: "Technology or GitHub repository",
          // Claude may still be looked for; the step itself says if it is not there.
          hint: s.llm || s.llmLookup ? "Next.js or vercel/next.js" : "owner/repo",
        },
        { value: "site", label: "Blog or feed URL", hint: "https://…" },
        { value: "news", label: "News search (Google News, free)", hint: "words, optionally on chosen sites" },
        // sources.yml needs a source; searches, if any are offered, are asked next.
        ...(count > 0 || tavilyApiKey(s.env) || mayOfferNews(s) ? [{ value: "done" as const, label: "Done" }] : []),
      ],
    });
    if (kind === "done") return added;

    const feed = kind === "repo" ? await askRepo(s) : kind === "site" ? await askSite(s) : await askNews(s);
    // Nothing found, or backed out: back to the choice above.
    if (!feed) continue;
    if (!claim(s, keyOf(feed), feed.id)) {
      s.p.warn("Already added; skipped.");
      continue;
    }
    added.push(feed);
  }
}

async function askRepo(s: SourceSession): Promise<FeedInput | undefined> {
  const llm = await getLlm(s);
  const answer = (
    await s.p.text({
      message: llm ? "Technology name or GitHub repository (empty to go back)" : "GitHub repository (empty to go back)",
      placeholder: llm ? "Next.js" : "vercel/next.js",
      validate: (v) => {
        const t = v.trim();
        if (t === "" || REPO_PATTERN.test(t)) return undefined;
        // Without Claude there is nothing to look a name up with; a slash means a repo was meant.
        return llm && !t.includes("/") ? undefined : "Enter it as owner/repo";
      },
    })
  ).trim();
  if (answer === "") return undefined;
  // Typed as owner/repo: used as is, never through the model.
  if (REPO_PATTERN.test(answer)) {
    // Checked before GitHub is asked, which allows few unauthenticated calls an hour.
    if (s.keys.has(repoKey(answer))) {
      s.p.warn("Already added; skipped.");
      return undefined;
    }
    return checkTypedRepo(s, answer);
  }
  // validate refuses a name without Claude, but an answer replayed after going back is not
  // validated again.
  if (!llm) {
    s.p.warn("Without Claude, enter the repository as owner/repo.");
    return undefined;
  }
  return lookUpRepo(s, llm, answer);
}

async function checkTypedRepo(s: SourceSession, repo: string): Promise<FeedInput | undefined> {
  const { p, signal } = s;
  let check: RepoCheck;
  try {
    check = await p.spin(`Checking ${repo} on GitHub`, () => verifyRepo(repo, signal), signal);
  } catch (err) {
    throwIfCancelled(signal);
    if (!(err instanceof HttpError || err instanceof FeedParseError)) throw err;
    // It may exist: the user typed it, so let them decide.
    p.warn(`Could not check ${repo} on GitHub: ${errorLine(err)}`);
    if (!(await p.confirm({ message: `Add ${repo} anyway?`, initialValue: false }))) return undefined;
    return repoFeed(s, repo);
  }
  return checkedRepoFeed(s, repo, check, "");
}

/** The feed for a repository GitHub answered about, or undefined (with a warning) when there is none to watch. */
function checkedRepoFeed(s: SourceSession, repo: string, check: RepoCheck, suffix: string): FeedInput | undefined {
  const { p } = s;
  if (check.status === "not_found") {
    p.warn(`${repo} was not found on GitHub${suffix}.`);
    return undefined;
  }
  const current = check.movedTo ?? repo;
  if (check.movedTo) p.note(`${repo} moved to ${current}; watching that instead.`);
  if (check.status === "empty") {
    p.warn(`${current} has no releases or tags to watch${suffix}.`);
    return undefined;
  }
  return repoFeed(s, current, check);
}

// Only repositories GitHub confirms are offered: a model can name ones that do not exist.
async function lookUpRepo(s: SourceSession, llm: LlmClient, name: string): Promise<FeedInput | undefined> {
  const { p, signal } = s;
  let candidates: { repo: string; note: string }[];
  try {
    const reply = await p.spin(
      `Asking Claude where ${name} is developed`,
      () => llm.generate(repoInferenceRequest(s.context, [name]), { signal }),
      signal,
    );
    candidates = reply.results.find((r) => r.id === queryId(0))?.candidates ?? [];
  } catch (err) {
    throwIfCancelled(signal);
    if (!(err instanceof LlmError)) throw err;
    llmFailed(s, err);
    p.warn(`Could not look up ${name}; enter it as owner/repo.`);
    return undefined;
  }

  const seen = new Set<string>();
  const named = candidates
    .map((c) => ({ repo: c.repo.trim(), note: c.note }))
    .filter((c) => REPO_PATTERN.test(c.repo) && once(seen, c.repo.toLowerCase()));
  // Ones already added are not checked again.
  const valid = named.filter((c) => !s.keys.has(repoKey(c.repo))).slice(0, MAX_REPO_CANDIDATES);
  if (named.length > 0 && valid.length === 0) {
    p.warn("Already added; skipped.");
    return undefined;
  }
  const checks =
    valid.length === 0
      ? []
      : await p.spin(
          `Checking ${plural(valid.length, "candidate")} on GitHub`,
          () => Promise.all(valid.map((c) => settle(verifyRepo(c.repo, signal)).then((result) => ({ ...c, result })))),
          signal,
        );
  throwIfCancelled(signal);

  const found: { repo: string; note: string; check: FoundRepo }[] = [];
  const current = new Set<string>();
  for (const { repo: candidate, note, result } of checks) {
    if (result.status !== "fulfilled" || result.value.status !== "found") continue;
    // Two candidates can be one repository under its old and new name.
    const repo = result.value.movedTo ?? candidate;
    if (once(current, repo.toLowerCase())) found.push({ repo, note, check: result.value });
  }
  const unchecked = checks.filter((c) => c.result.status === "rejected").length;
  if (found.length === 0) {
    // A rate limit or a network failure says nothing about whether the repository exists.
    p.warn(
      unchecked > 0
        ? `Could not check ${plural(unchecked, "candidate")} for ${name} on GitHub; try again later or enter it as owner/repo.`
        : `No GitHub repository found for ${name}; enter it as owner/repo.`,
    );
    return undefined;
  }
  if (unchecked > 0) p.warn(`Could not check ${plural(unchecked, "candidate")} on GitHub; left out.`);

  const choice = await p.select({
    message: `Which repository is ${name}?`,
    options: [
      ...found.map((f) => ({ value: f.repo, label: f.repo, hint: displayLine(f.note, HINT_MAX_CHARS) || undefined })),
      { value: NONE, label: "None of these" },
    ],
  });
  const chosen = found.find((f) => f.repo === choice);
  return chosen && repoFeed(s, chosen.repo, chosen.check);
}

function repoFeed(s: SourceSession, repo: string, check?: FoundRepo): FeedInput {
  // Otherwise nothing would arrive until the first stable release.
  if (check?.onlyPrereleases) s.p.note(`${repo} has only prereleases so far; following them.`);
  const feed: FeedInput = {
    // Named after the repository, not its owner.
    id: sourceIdFrom(repo.split("/")[1] ?? repo, s.ids),
    type: "github",
    name: repo,
    repo,
    ...(check?.feed === "tags" && { feed: "tags" as const }),
    ...(check?.onlyPrereleases && { includePrereleases: true }),
  };
  if (check) s.checked.set(feed, check.latest);
  return feed;
}

async function askSite(s: SourceSession): Promise<FeedInput | undefined> {
  const raw = (
    await s.p.text({
      message: "Blog or feed URL (empty to go back)",
      placeholder: "https://simonwillison.net/",
      validate: (v) => (v.trim() === "" || parseHttpUrl(v.trim()) ? undefined : "Enter an absolute http(s) URL"),
    })
  ).trim();
  if (raw === "") return undefined;
  // validate refuses anything else, but an answer replayed after going back is not validated again.
  const url = parseHttpUrl(raw);
  if (!url) {
    s.p.warn("Enter an absolute http(s) URL.");
    return undefined;
  }
  return resolveSite(s, url.href);
}

/** Finds the feed of a page, asking which one when it has several. */
async function resolveSite(s: SourceSession, url: string): Promise<FeedInput | undefined> {
  const { p, signal } = s;
  // Given as the feed itself; one found on a page is checked when it is added.
  if (s.keys.has(feedKey(url))) {
    p.warn("Already added; skipped.");
    return undefined;
  }
  const found = await settle(p.spin(`Looking for feeds on ${url}`, () => discoverFeeds(url, signal), signal));
  throwIfCancelled(signal);
  return pickSiteFeed(s, url, found, true);
}

/**
 * Turns what discoverFeeds settled with into a feed, asking which one when the page has several.
 * A feed that could not be checked is offered anyway only when the user typed the URL: a
 * proposed one is left out, since nobody vouches for it.
 */
async function pickSiteFeed(
  s: SourceSession,
  url: string,
  found: PromiseSettledResult<DiscoveredFeed[]>,
  typed: boolean,
): Promise<FeedInput | undefined> {
  const { p } = s;
  const leftOut = typed ? "" : "; left out";
  if (found.status === "rejected") {
    const err: unknown = found.reason;
    // The page opened; a feed it led to did not.
    if (err instanceof FeedCheckError) {
      p.warn(`Could not check a feed on ${url}: ${errorLine(err)}${leftOut}`);
      // An advertised feed may be up again by the next run; a guessed path may be no feed at all.
      const shown = displayLine(err.feedUrl, SHOWN_MAX_CHARS);
      if (!typed || !err.advertised || !(await p.confirm({ message: `Add ${shown} anyway?`, initialValue: false }))) {
        return undefined;
      }
      return siteFeed(s, url, err.feedUrl);
    }
    if (!(err instanceof HttpError)) throw err;
    p.warn(`Could not open ${url}: ${errorLine(err)}${leftOut}`);
    // It may be up again by the next run; the user typed it, so let them decide.
    if (!typed || !isTransient(err) || !(await p.confirm({ message: `Add ${url} as a feed anyway?`, initialValue: false }))) {
      return undefined;
    }
    return siteFeed(s, url, url);
  }
  const feeds = found.value;
  const [first, ...others] = feeds;
  if (!first) {
    p.warn(`No feed found on ${url}${leftOut}.`);
    return undefined;
  }
  if (others.length === 0) return siteFeed(s, url, first.url);
  const choice = await p.select({
    message: `${url} has ${feeds.length} feeds; which one?`,
    options: [
      // The titles come from the page.
      ...feeds.map((f) => ({
        value: f.url,
        label: (f.title && displayLine(f.title, SHOWN_MAX_CHARS)) || f.url,
        ...(f.title && { hint: f.url }),
      })),
      { value: NONE, label: "None of these" },
    ],
  });
  const chosen = feeds.find((f) => f.url === choice);
  return chosen && siteFeed(s, url, chosen.url, chosen.title);
}

// Named after the URL the user gave, not the feed's host (feeds.feedburner.com), with its path
// so feeds on one host differ, and with the title the page gave the feed chosen among several.
function siteFeed(s: SourceSession, pageUrl: string, feedUrl: string, title?: string): FeedInput {
  const page = new URL(pageUrl);
  const host = page.hostname.replace(/^www\./, "");
  const base = `${host}${page.pathname.replace(/\/+$/, "")}`;
  const shown = title && displayLine(title, HINT_MAX_CHARS);
  return { id: sourceIdFrom(host, s.ids), type: "rss", name: shown ? `${base}: ${shown}` : base, url: feedUrl };
}

/**
 * Offers the proposed repositories and sites, all picked, and keeps those GitHub confirms or that
 * have a feed. Unlike a name typed in, a proposed repository GitHub cannot check is left out:
 * nobody typed it, so nobody vouches for it.
 */
export async function addProposedFeeds(s: SourceSession, proposal: Pick<Proposal, "repos" | "sites">): Promise<FeedInput[]> {
  const { p, signal } = s;
  const added: FeedInput[] = [];
  const keep = (feed: FeedInput | undefined) => {
    if (!feed) return;
    if (claim(s, keyOf(feed), feed.id)) added.push(feed);
    else p.warn(`Already added: ${displayLine(labelOf(feed), SHOWN_MAX_CHARS)}; skipped.`);
  };

  const seenRepos = new Set<string>();
  const repos = proposal.repos.filter((r) => once(seenRepos, r.repo.toLowerCase()));
  const chosenRepos =
    repos.length === 0
      ? []
      : await p.multiselect({
          message: "Proposed repositories to watch (space to toggle)",
          options: repos.map((r) => ({ value: r.repo, label: r.repo, hint: displayLine(r.evidence, HINT_MAX_CHARS) || undefined })),
          initialValues: repos.map((r) => r.repo),
        });
  if (chosenRepos.length > 0) {
    const limit = pLimit(GITHUB_CONCURRENCY);
    const checks = await p.spin(
      `Checking ${plural(chosenRepos.length, "repository", "repositories")} on GitHub`,
      () =>
        Promise.all(
          chosenRepos.map((repo) => settle(limit(() => verifyRepo(repo, signal))).then((result) => ({ repo, result }))),
        ),
      signal,
    );
    throwIfCancelled(signal);
    // In the order proposed, one at a time: each id is chosen against the ones claimed before it.
    for (const { repo, result } of checks) {
      if (result.status === "rejected") {
        const err: unknown = result.reason;
        if (!(err instanceof HttpError || err instanceof FeedParseError)) throw err;
        p.warn(`Could not check ${repo} on GitHub: ${errorLine(err)}; left out.`);
        continue;
      }
      keep(checkedRepoFeed(s, repo, result.value, "; left out"));
    }
  }

  const seenSites = new Set<string>();
  const sites = proposal.sites.filter((site) => once(seenSites, normalizeUrl(site.url) ?? site.url));
  const chosenSites =
    sites.length === 0
      ? []
      : await p.multiselect({
          message: "Proposed sites to watch (space to toggle)",
          options: sites.map((site) => ({
            value: site.url,
            label: displayLine(site.url, SHOWN_MAX_CHARS),
            hint: displayLine(site.evidence, HINT_MAX_CHARS) || undefined,
          })),
          initialValues: sites.map((site) => site.url),
        });
  if (chosenSites.length > 0) {
    const limit = pLimit(SITE_CONCURRENCY);
    const found = await p.spin(
      `Looking for feeds on ${plural(chosenSites.length, "site")}`,
      () =>
        Promise.all(
          chosenSites.map((url) => settle(limit(() => discoverFeeds(url, signal))).then((result) => ({ url, result }))),
        ),
      signal,
    );
    throwIfCancelled(signal);
    // In the order proposed, one at a time: a page with several feeds asks which one.
    for (const { url, result } of found) keep(await pickSiteFeed(s, url, result, false));
  }
  return added;
}
