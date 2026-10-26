import type { GithubFeed, Sources } from "../config/schema.js";
import type { Item } from "../types.js";
import { fetchText, HttpError } from "../util/http.js";
import { parseFeedText, toItems, type RawEntry } from "./rss.js";

type GithubFeedKind = GithubFeed["feed"];

// A digit must come first, so a package name such as "eslint-config-next@14.0.0" is not a
// prerelease, and no letter may follow, so "v2.0.0-devtools" is not one either.
const PRERELEASE = /\d-(?:alpha|beta|rc|canary|next|preview|nightly|dev)(?![a-z])/i;

export function feedUrl(repo: string, feed: GithubFeedKind): string {
  return `https://github.com/${repo}/${feed}.atom`;
}

export function isPrerelease(tag: string): boolean {
  return PRERELEASE.test(tag);
}

export type RepoCheck =
  | { status: "found"; feed: GithubFeedKind }
  /** The repository exists but has neither releases nor tags. */
  | { status: "empty" }
  | { status: "not_found" };

/**
 * Tells a missing repository (404) from one we could not check: other HTTP errors, network
 * failures and unparsable responses throw.
 */
export async function verifyRepo(repo: string, signal?: AbortSignal): Promise<RepoCheck> {
  let releases: RawEntry[];
  try {
    releases = await fetchEntries(feedUrl(repo, "releases"), signal);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return { status: "not_found" };
    throw err;
  }
  // Counted before dropping prereleases: the question is whether the repository exists.
  if (releases.length > 0) return { status: "found", feed: "releases" };
  const tags = await fetchEntries(feedUrl(repo, "tags"), signal);
  return tags.length > 0 ? { status: "found", feed: "tags" } : { status: "empty" };
}

async function fetchEntries(url: string, signal?: AbortSignal): Promise<RawEntry[]> {
  return parseFeedText((await fetchText(url, { signal })).text);
}

export async function fetchGithubItems(
  feed: GithubFeed,
  defaults: Sources["defaults"],
  signal?: AbortSignal,
): Promise<Item[]> {
  const res = await fetchText(feedUrl(feed.repo, feed.feed), { signal });
  const entries = parseFeedText(res.text);
  // Before toItems cuts to itemsPerFeed, so a run of canaries cannot push out the stable release.
  const kept = feed.includePrereleases ? entries : entries.filter((e) => !isPrerelease(tagOf(e)));
  return toItems(kept, { ...feed, kind: "github" }, { baseUrl: res.url, ...defaults });
}

// The title is the release name ("Next.js 16"), which need not match the tag, so it comes last.
function tagOf(entry: RawEntry): string {
  const path = entry.link?.match(/\/releases\/tag\/([^?#]+)/)?.[1];
  if (path) {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }
  // "tag:github.com,2008:Repository/70107786/v16.1.0"
  const fromGuid = entry.guid?.match(/^tag:github\.com,\d+:Repository\/\d+\/(.+)$/)?.[1];
  return fromGuid ?? entry.title?.value ?? "";
}
