import { type Context, DomainSchema } from "../../config/schema.js";
import { MAX_QUERY_SUGGESTIONS, querySuggestionRequest } from "../../llm/prompts.js";
import { LlmError } from "../../llm/schema.js";
import { tavilyApiKey } from "../../sources/tavily.js";
import { displayLine, plural } from "../../util/text.js";
import { queryIdFrom } from "./ids.js";
import { watchQueries } from "./ideas.js";
import {
  type FeedInput,
  type QueryInput,
  type QuerySuggestion,
  cleanQuery,
  cleanSuggestions,
  keyOf,
  newsKey,
  queryKey,
} from "./keys.js";
import { askAddOwn, askList } from "./lists.js";
import {
  HINT_MAX_CHARS,
  SHOWN_MAX_CHARS,
  type SourceSession,
  claim,
  getLlm,
  llmFailed,
  throwIfCancelled,
} from "./session.js";

const MAX_TYPED_QUERIES = 10;
// Tavily's free plan, per month.
const TAVILY_FREE_CREDITS = 1000;

// Google News editions by the summary language; the rest search the English one.
const LOCALES: Record<string, string> = { English: "en-US", Japanese: "ja-JP" };

function localeOf(context: Context): string {
  return LOCALES[context.language] ?? "en-US";
}

function newsFeed(s: SourceSession, query: string, sites: string[] | undefined): FeedInput | undefined {
  const id = queryIdFrom(query, s.ids);
  return { id, type: "googlenews", query, ...(sites && sites.length > 0 && { sites }), locale: localeOf(s.context) };
}

/** Typed from the sources menu: the words, then the sites to keep to. */
export async function askNews(s: SourceSession): Promise<FeedInput | undefined> {
  const query = cleanQuery(
    await s.p.text({ message: "Google News search (empty to go back)", placeholder: "Qwen model release" }),
  );
  if (query === "") return undefined;
  const typed = await s.p.text({
    message: "Only on these sites (domain names, comma-separated; empty for any)",
    placeholder: "prtimes.jp",
    validate: (v) => (parseSites(v) === undefined ? "Enter domain names such as prtimes.jp, separated by commas" : undefined),
  });
  return newsFeed(s, query, parseSites(typed));
}

function parseSites(value: string): string[] | undefined {
  const parts = value.split(/[,、\s]+/).filter((v) => v !== "");
  const sites = parts.map((v) => DomainSchema.safeParse(v).data);
  return sites.every((d) => d !== undefined) ? [...new Set(sites)] : undefined;
}

// Searches will be offered after the menu: some are known, or Claude may still suggest some.
export function mayOfferNews(s: SourceSession): boolean {
  return offeredNews(s).length > 0 || (s.suggestions === undefined && (s.llm !== undefined || s.llmLookup !== undefined));
}

/** News searches offered without asking Claude: named on the command line, proposed, from ideas. */
function offeredNews(s: SourceSession): QuerySuggestion[] {
  const news = (s.suggestions ?? []).filter((q) => q.topic === "news");
  return cleanSuggestions([...watchQueries(s.watch), ...news, ...(s.ideaQueries ?? [])]).filter(
    (q) => !s.keys.has(newsKey(q.query, q.includeDomains)),
  );
}

/**
 * Offers searches as Google News feeds: free and keyless, so asked whether or not Tavily is set
 * up. Claude is asked for suggestions once when nothing was proposed. Proposed ones (from the
 * proposal or the ideas picked) are picked to begin with.
 */
export async function askNewsSearches(s: SourceSession): Promise<FeedInput[]> {
  const { p, signal } = s;
  if (s.suggestions === undefined) {
    const llm = await getLlm(s);
    s.suggestions = [];
    if (llm) {
      try {
        const reply = await p.spin(
          "Asking Claude for search queries",
          () => llm.generate(querySuggestionRequest(s.context, s.watch), { signal }),
          signal,
        );
        s.suggestions = cleanSuggestions(reply.queries.map((query) => ({ query, topic: "news" as const }))).slice(
          0,
          MAX_QUERY_SUGGESTIONS,
        );
      } catch (err) {
        throwIfCancelled(signal);
        if (!(err instanceof LlmError)) throw err;
        llmFailed(s, err);
      }
    }
  }
  const offered = offeredNews(s);
  if (offered.length === 0) return [];
  const picked = await p.multiselect({
    message: "News searches to run (Google News, free; space to select)",
    options: offered.map((q) => ({
      value: q.query,
      label: displayLine(q.query, SHOWN_MAX_CHARS),
      hint: q.hint && (displayLine(q.hint, HINT_MAX_CHARS) || undefined),
    })),
    initialValues: offered.filter((q) => q.proposed).map((q) => q.query),
  });
  const added: FeedInput[] = [];
  for (const q of offered.filter((o) => picked.includes(o.query))) {
    const feed = newsFeed(s, q.query, q.includeDomains);
    if (feed && claim(s, keyOf(feed), feed.id)) added.push(feed);
  }
  return added;
}

/**
 * Offers web searches, which run on Tavily: only with a key, and with what they cost said first,
 * since each one is a paid search on every run. The proposal's general queries are the
 * candidates (news ones went to Google News); none is picked for the user.
 */
export async function askWebSearches(s: SourceSession): Promise<QueryInput[]> {
  const { p } = s;
  const candidates = cleanSuggestions((s.suggestions ?? []).filter((q) => q.topic === "general")).filter(
    (q) => !s.keys.has(queryKey(q.query)),
  );
  // A run reads the same key (from process.env, which env is outside tests), so a query asked
  // for here is one a run can fetch.
  if (!tavilyApiKey(s.env)) {
    if (!s.tavilyNoted && candidates.length > 0) {
      p.note(
        `TAVILY_API_KEY is not set, so web searches are skipped (${plural(candidates.length, "proposed web search", "proposed web searches")} left out).`,
      );
    }
    s.tavilyNoted = true;
    return [];
  }
  const runs = s.runsPerMonth;
  const each = runs === undefined ? "" : ` (about ${plural(runs, "credit")} a month each at this schedule)`;
  if (!s.tavilyNoted) {
    p.note(
      `Web searches run on Tavily, a paid search API: each one costs a credit on every run${each}, and one now to try it. The free plan has ${TAVILY_FREE_CREDITS} credits a month, so add only what a news search cannot find.`,
      "Tavily",
    );
  }
  s.tavilyNoted = true;

  const chosen: QuerySuggestion[] = [];
  let addOwn = true;
  if (candidates.length > 0) {
    const picked = await p.multiselect({
      message: "Web searches to run (Tavily, paid; space to select)",
      options: candidates.map((q) => ({
        value: q.query,
        label: displayLine(q.query, SHOWN_MAX_CHARS),
        hint: q.hint && (displayLine(q.hint, HINT_MAX_CHARS) || undefined),
      })),
    });
    chosen.push(...candidates.filter((q) => picked.includes(q.query)));
    addOwn = await askAddOwn(p, picked.length);
  }
  const typed = addOwn
    ? await askList(p, { message: "Add a web search (Tavily)", placeholder: "Qwen Image LoRA", min: 0, max: MAX_TYPED_QUERIES })
    : [];
  // Control characters alone clean to nothing.
  chosen.push(...typed.map(cleanQuery).filter((q) => q !== "").map((query) => ({ query, topic: "general" as const })));

  const added: QueryInput[] = [];
  for (const { query, topic, includeDomains } of chosen) {
    const id = queryIdFrom(query, s.ids);
    if (!claim(s, queryKey(query), id)) {
      p.warn(`Already added: ${displayLine(query, SHOWN_MAX_CHARS)}; skipped.`);
      continue;
    }
    added.push({ id, query, topic, ...(includeDomains && { includeDomains }) });
  }
  const total = s.queries.length + added.length;
  if (added.length > 0 && runs !== undefined) {
    const credits = total * runs;
    const line = `${plural(total, "web search", "web searches")}: about ${plural(credits, "Tavily credit")} a month.`;
    if (credits > TAVILY_FREE_CREDITS) p.warn(`${line} That is more than the ${TAVILY_FREE_CREDITS} the free plan has.`);
    else p.note(line, "Tavily");
  }
  return added;
}
