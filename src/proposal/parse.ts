import { open } from "node:fs/promises";
import { z } from "zod";
import { ConfigError } from "../config/load.js";
import { DomainSchema, MAX_DOMAINS, REPO_PATTERN } from "../config/schema.js";
import { parseHttpUrl } from "../util/hash.js";
import { displayLine as clean } from "../util/text.js";
import { PROPOSAL_LIMITS, PROPOSAL_VERSION } from "./prompt.js";

const MAX_BYTES = 256 * 1024;
const TEXT_MAX_CHARS = 200;
const EVIDENCE_MAX_CHARS = 120;

/** A line of text the user picks or leaves, with where the agent found it. */
export interface ProposedText {
  text: string;
  evidence: string;
}

export interface Proposal {
  project: { name: string; description: string };
  language?: string;
  problems: ProposedText[];
  exclude: ProposedText[];
  repos: { repo: string; evidence: string }[];
  sites: { url: string; evidence: string }[];
  queries: { query: string; topic: "news" | "general"; evidence: string; includeDomains?: string[] }[];
  /** Entries left out because they were malformed or past the limits. */
  dropped: number;
}

// Loose: agents add keys of their own, and a key nobody reads is no reason to refuse the file.
const optionalText = z.string().optional().catch(undefined);
const list = z.array(z.unknown()).optional().catch(undefined);
const TopSchema = z.looseObject({
  pochi: z.literal(PROPOSAL_VERSION),
  project: z.looseObject({ name: optionalText, description: optionalText }).optional().catch(undefined),
  language: optionalText,
  problems: list,
  exclude: list,
  repos: list,
  sites: list,
  queries: list,
});
const TextEntry = z.looseObject({ text: z.string(), axis: optionalText, evidence: optionalText });
const RepoEntry = z.looseObject({ repo: z.string(), evidence: optionalText });
const SiteEntry = z.looseObject({ url: z.string(), evidence: optionalText });
const QueryEntry = z.looseObject({
  query: z.string(),
  topic: z.enum(["news", "general"]).optional().catch(undefined),
  intent: optionalText,
  evidence: optionalText,
  includeDomains: list,
});

/** Reads a proposal written by an agent; ConfigError (exit 2) when there is none to use. */
export async function readProposal(path: string): Promise<Proposal> {
  let bytes: Buffer;
  try {
    // At most one byte past the limit is read, so /dev/zero or a huge log cannot fill memory.
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) throw new Error("not a regular file");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length === buffer.length) break;
      }
      bytes = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  } catch (err) {
    throw new ConfigError(`cannot read the proposal ${path}`, { cause: err });
  }
  if (bytes.length > MAX_BYTES) throw new ConfigError(`the proposal ${path} is larger than ${MAX_BYTES / 1024} KB`);
  return parseProposal(bytes.toString("utf8"), path);
}

/**
 * Takes the JSON as is, or the last fenced block that holds a proposal when the agent wrapped it
 * in prose.
 * The file came from a model reading a repository, so messages never quote it.
 */
export function parseProposal(text: string, label: string): Proposal {
  const json = extractJson(text);
  if (json === undefined) throw new ConfigError(`${label}: no JSON proposal found`);
  const top = TopSchema.safeParse(json);
  if (!top.success) {
    throw new ConfigError(`${label}: not a Pochi proposal (expected "pochi": "${PROPOSAL_VERSION}")`);
  }
  const p = top.data;
  let dropped = 0;

  // Each entry stands alone: one malformed entry costs only itself.
  function entries<S extends z.ZodType, R>(
    raw: unknown[] | undefined,
    schema: S,
    max: number,
    map: (entry: z.output<S>) => R | undefined,
  ): R[] {
    const out: R[] = [];
    for (const item of raw ?? []) {
      const parsed = schema.safeParse(item);
      const value = parsed.success ? map(parsed.data) : undefined;
      if (value === undefined || out.length >= max) dropped++;
      else out.push(value);
    }
    return out;
  }

  // The axis or intent leads, so a hint shows why before where.
  const evidence = (e: { axis?: string; evidence?: string }) =>
    clean([e.axis, e.evidence].filter(Boolean).join(" · "), EVIDENCE_MAX_CHARS);
  const proposedText = (e: z.output<typeof TextEntry>) => {
    const text = clean(e.text, TEXT_MAX_CHARS);
    return text ? { text, evidence: evidence(e) } : undefined;
  };

  const language = clean(p.language ?? "", TEXT_MAX_CHARS);
  return {
    project: {
      name: clean(p.project?.name ?? "", TEXT_MAX_CHARS),
      description: clean(p.project?.description ?? "", TEXT_MAX_CHARS * 2),
    },
    ...(language && { language }),
    problems: entries(p.problems, TextEntry, PROPOSAL_LIMITS.problems, proposedText),
    exclude: entries(p.exclude, TextEntry, PROPOSAL_LIMITS.exclude, proposedText),
    repos: entries(p.repos, RepoEntry, PROPOSAL_LIMITS.repos, (e) => {
      const repo = e.repo.trim();
      return REPO_PATTERN.test(repo) ? { repo, evidence: evidence(e) } : undefined;
    }),
    sites: entries(p.sites, SiteEntry, PROPOSAL_LIMITS.sites, (e) => {
      const url = parseHttpUrl(e.url.trim())?.href;
      return url ? { url, evidence: evidence(e) } : undefined;
    }),
    queries: entries(p.queries, QueryEntry, PROPOSAL_LIMITS.queries, (e) => {
      const query = clean(e.query, TEXT_MAX_CHARS);
      if (!query) return undefined;
      // A domain that is not one is left out; the query still searches, just not only there.
      const domains = [
        ...new Set((e.includeDomains ?? []).flatMap((d) => DomainSchema.safeParse(d).data ?? [])),
      ].slice(0, MAX_DOMAINS);
      return {
        query,
        topic: e.topic ?? "news",
        evidence: evidence({ axis: e.intent, evidence: e.evidence }),
        ...(domains.length > 0 && { includeDomains: domains }),
      };
    }),
    dropped,
  };
}

/**
 * The proposal's JSON value, or undefined when the text holds none. A block tagged with this
 * version wins over any other object, so an example the agent adds after it is not taken instead.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.replace(/^﻿/, "").trim();
  const whole = trimmed.startsWith("{") ? tryParse(trimmed) : undefined;
  if (whole !== undefined) return whole;
  let found: unknown;
  let tagged: unknown;
  // Fences open and close at the start of a line; a ``` mentioned mid-sentence is prose.
  for (const match of trimmed.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
    const value = tryParse(match[1]!);
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    found = value;
    if ((value as { pochi?: unknown }).pochi === PROPOSAL_VERSION) tagged = value;
  }
  return tagged ?? found;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
