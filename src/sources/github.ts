import * as z from "zod";
import type { GithubFeed } from "../config/schema.js";
import type { FetchDefaults, Item } from "../types.js";
import { fetchText, HttpError, isServerSide } from "../util/http.js";
import { log } from "../util/log.js";
import { parseApi } from "./api.js";
import { fetchFeedEntries, fetchFeedItems, toItems, type RawEntry } from "./rss.js";

type GithubFeedKind = GithubFeed["feed"];

const API = "https://api.github.com";
// The Atom feeds hold only the newest 10 entries, so a run of canaries can hide every stable
// release. The API returns up to 100, each flagged prerelease or not by its author.
const RELEASES_PER_PAGE = 100;
// A hundred release notes with rendered HTML can pass the 2MB default.
const API_MAX_BYTES = 8 * 1024 * 1024;

// The suffix must follow a version such as "1.2" or "v16.1.0", so a package name such as
// "eslint-config-next@14.0.0" or "python3-dev@1.2.0" is not a prerelease, and no letter may
// follow it, so "v2.0.0-devtools" is not one either. Also covers PEP 440 ("1.0.0rc1", "2.0b2")
// and Maven ("2.0.0-M1", "1.0-SNAPSHOT").
const PRERELEASE =
  /(?<![a-z\d.])v?\d+(?:\.\d+)+(?:[-.]?(?:alpha|beta|rc|canary|next|preview|pre|nightly|dev|experimental|snapshot)|(?:a|b)(?=\d)|-m(?=\d))(?![a-z])/i;

export function feedUrl(repo: string, feed: GithubFeedKind): string {
  return `https://github.com/${repo}/${feed}.atom`;
}

export function isPrerelease(tag: string): boolean {
  return PRERELEASE.test(tag);
}

const RepoSchema = z.object({ full_name: z.string() });

const ReleasesSchema = z.array(
  z.object({
    html_url: z.string(),
    tag_name: z.string(),
    name: z.string().nullish(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullish(),
    body_html: z.string().nullish(),
    // Only in the markdown fallback.
    body: z.string().nullish(),
  }),
);

type Release = z.infer<typeof ReleasesSchema>[number];

export type RepoCheck =
  | {
      status: "found";
      feed: GithubFeedKind;
      /** Every release is a prerelease, so nothing shows unless includePrereleases is set. */
      onlyPrereleases?: true;
      /** The repository was renamed or transferred; this is its current owner/repo. */
      movedTo?: string;
      /** The newest item a run would show, from the responses already fetched (content left empty). */
      latest?: Item;
    }
  /** The repository exists but has neither releases nor tags. */
  | { status: "empty"; movedTo?: string }
  | { status: "not_found" };

/**
 * Tells a missing repository (404) from one we could not check: other HTTP errors, network
 * failures and unparsable responses throw.
 */
export async function verifyRepo(repo: string, signal?: AbortSignal): Promise<RepoCheck> {
  let current: string;
  try {
    const res = await fetchText(`${API}/repos/${repo}`, { signal, headers: apiHeaders("json") });
    // The API follows a rename or transfer, and full_name is where the repository lives now.
    current = parseApi(res.text, RepoSchema, res.url, "GitHub API").full_name;
  } catch (err) {
    if (isNotFound(err)) return { status: "not_found" };
    throw err;
  }
  const moved = current.toLowerCase() === repo.toLowerCase() ? {} : { movedTo: current };

  const releases = await fetchReleases(current, "json", signal);
  if (releases.length > 0) {
    const onlyPre = releases.every((r) => r.prerelease);
    const shown = onlyPre ? releases : releases.filter((r) => !r.prerelease);
    return found("releases", current, shown.map(toEntry), "https://github.com/", onlyPre, moved);
  }
  let tags: { entries: RawEntry[]; url: string };
  try {
    tags = await fetchFeedEntries(feedUrl(current, "tags"), signal);
  } catch (err) {
    // Deleted or made private since the first request.
    if (isNotFound(err)) return { status: "not_found" };
    throw err;
  }
  if (tags.entries.length === 0) return { status: "empty", ...moved };
  const onlyPre = tags.entries.every((e) => isPrerelease(tagOf(e)));
  const shown = onlyPre ? tags.entries : tags.entries.filter((e) => !isPrerelease(tagOf(e)));
  return found("tags", current, shown, tags.url, onlyPre, moved);
}

// The prerelease rule is the one fetchGithubItems applies once includePrereleases follows onlyPrereleases.
function found(
  feed: GithubFeedKind,
  repo: string,
  entries: RawEntry[],
  baseUrl: string,
  onlyPrereleases: boolean,
  moved: { movedTo?: string },
): RepoCheck {
  const [latest] = toItems(entries, { id: repo, name: repo, kind: "github" }, { baseUrl, itemsPerFeed: 1, maxContentChars: 0 });
  return {
    status: "found",
    feed,
    ...(onlyPrereleases && { onlyPrereleases: true as const }),
    ...moved,
    ...(latest && { latest }),
  };
}

export async function fetchGithubItems(
  feed: GithubFeed,
  defaults: FetchDefaults,
  signal?: AbortSignal,
): Promise<Item[]> {
  const source = { ...feed, kind: "github" as const };
  if (feed.feed === "tags") {
    return fetchFeedItems(feedUrl(feed.repo, "tags"), source, defaults, signal, (entries) =>
      dropPrereleases(feed, entries, (e) => isPrerelease(tagOf(e))),
    );
  }
  const releases = await fetchReleaseNotes(feed.repo, signal, defaults.env);
  // Before toItems cuts to itemsPerFeed, so a run of canaries cannot push out the stable release.
  const kept = dropPrereleases(feed, releases, (r) => r.prerelease);
  // html_url is absolute, so the base only matters for a malformed one.
  return toItems(kept.map(toEntry), source, { baseUrl: "https://github.com/", ...defaults });
}

// GitHub renders body_html within a time limit that a hundred long release notes pass (nodejs/node
// answers 502, or drops the connection, every time), so a server-side failure is not retried as
// HTML: the markdown bodies come back at once and read well enough as text.
async function fetchReleaseNotes(repo: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<Release[]> {
  try {
    return await fetchReleases(repo, "html", signal, env, { server: 0 });
  } catch (err) {
    if (!(err instanceof HttpError && isServerSide(err)) || signal?.aborted) throw err;
    log.debug(`${repo}: GitHub could not render the release notes (${err.message}), reading them as markdown`);
    return fetchReleases(repo, "json", signal, env);
  }
}

async function fetchReleases(
  repo: string,
  body: "json" | "html",
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
  retry?: { server: number },
): Promise<Release[]> {
  const res = await fetchText(releasesUrl(repo), {
    signal,
    headers: apiHeaders(body, env),
    maxBytes: API_MAX_BYTES,
    ...(retry && { retry }),
  });
  return parseApi(res.text, ReleasesSchema, res.url, "GitHub API").filter((r) => !r.draft);
}

function releasesUrl(repo: string): string {
  return `${API}/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}`;
}

// "html" asks for body_html, which goes through the same HTML-to-text path as feed content.
function apiHeaders(body: "json" | "html", env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    accept: body === "html" ? "application/vnd.github.html+json" : "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  // Optional: without it the API allows 60 requests an hour per IP, which shared CI runners can exhaust.
  const token = env.GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}

function dropPrereleases<T>(feed: GithubFeed, all: T[], isPre: (t: T) => boolean): T[] {
  if (feed.includePrereleases) return all;
  const kept = all.filter((t) => !isPre(t));
  if (kept.length === 0 && all.length > 0) {
    log.warn(
      `${feed.id}: all ${all.length} recent ${feed.feed} of ${feed.repo} are prereleases; ` +
        "set includePrereleases: true to follow them",
    );
  }
  return kept;
}

function toEntry(release: Release): RawEntry {
  return {
    link: release.html_url,
    title: { value: release.name?.trim() || release.tag_name, format: "text" },
    published: release.published_at ?? undefined,
    html: release.body_html ?? undefined,
    text: release.body ?? undefined,
  };
}

// The guid always names this entry's own tag; the title is the release name ("Next.js 16"),
// which need not match the tag, so it comes last.
function tagOf(entry: RawEntry): string {
  // "tag:github.com,2008:Repository/70107786/v16.1.0"
  const fromGuid = entry.guid?.match(/^tag:github\.com,\d+:Repository\/\d+\/(.+)$/)?.[1];
  if (fromGuid) return fromGuid;
  const path = entry.link?.match(/\/releases\/tag\/([^?#]+)/)?.[1];
  if (path) {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }
  return entry.title?.value ?? "";
}
