import { MAX_PROBLEMS } from "../../config/schema.js";
import { MAX_IDEAS, MAX_IDEA_QUERIES, MAX_IDEA_SITES, ideaSuggestionRequest } from "../../llm/prompts.js";
import { type IdeaSuggestionOutput, LlmError } from "../../llm/schema.js";
import type { Watchlist } from "../../proposal/prompt.js";
import { parseHttpUrl } from "../../util/hash.js";
import { displayLine, plural } from "../../util/text.js";
import { type QuerySuggestion, cleanQuery, once } from "./keys.js";
import { HINT_MAX_CHARS, SHOWN_MAX_CHARS, type SourceSession, getLlm, llmFailed, throwIfCancelled } from "./session.js";

export type Ideas = { problems: string[]; sites: { url: string; evidence: string }[]; queries: QuerySuggestion[] };

/**
 * Asks Claude for interests the answers so far may miss (tech, design, marketing, industry and more), each
 * with sites and queries that would bring news on it. The sites and queries of the ideas picked
 * are offered with the rest of the sources, and checked the same way.
 */
export async function askIdeas(s: SourceSession): Promise<Ideas> {
  const { p, signal } = s;
  const none: Ideas = { problems: [], sites: [], queries: [] };
  const room = MAX_PROBLEMS - s.context.problems.length;
  if (room <= 0) return none;
  // So nobody picks a dozen ideas only to have most of them cut.
  p.note(`${s.context.problems.length} of ${MAX_PROBLEMS} interests so far.`, "Interests");
  const wanted = await p.confirm({
    message: "Ask Claude for ideas from technology, design, marketing and industry angles you may have missed?",
    initialValue: true,
  });
  if (!wanted) return none;
  const llm = await getLlm(s);
  if (!llm) return none;
  let reply: IdeaSuggestionOutput;
  try {
    reply = await p.spin(
      "Asking Claude for ideas",
      () => llm.generate(ideaSuggestionRequest(s.context, s.watch), { signal }),
      signal,
    );
  } catch (err) {
    throwIfCancelled(signal);
    if (!(err instanceof LlmError)) throw err;
    llmFailed(s, err);
    return none;
  }

  const seen = new Set(s.context.problems.map((t) => t.toLowerCase()));
  const ideas = reply.ideas
    .map((idea) => ({ ...idea, problem: cleanQuery(idea.problem) }))
    .filter((idea) => idea.problem !== "" && once(seen, idea.problem.toLowerCase()))
    .slice(0, MAX_IDEAS);
  if (ideas.length === 0) {
    p.note("Claude had nothing to add.");
    return none;
  }
  // None picked to begin with: each brings more news on every run.
  const picked = await p.multiselect({
    message: "Ideas to add to what you want to hear about (space to select, enter to confirm)",
    options: ideas.map((idea) => ({
      value: idea.problem,
      label: `[${idea.perspective}] ${displayLine(idea.problem, SHOWN_MAX_CHARS)}`,
      hint: displayLine(idea.why, HINT_MAX_CHARS) || undefined,
    })),
  });
  if (picked.length > room) p.warn(`Only ${plural(room, "more interest")} fit; kept the first ${room}.`);
  const chosen = ideas.filter((idea) => picked.includes(idea.problem)).slice(0, room);
  return {
    problems: chosen.map((idea) => idea.problem),
    sites: chosen.flatMap((idea) =>
      idea.sites
        .slice(0, MAX_IDEA_SITES)
        .map((url) => parseHttpUrl(url.trim())?.href)
        .filter((url) => url !== undefined)
        .map((url) => ({ url, evidence: `idea: ${idea.perspective}` })),
    ),
    queries: chosen.flatMap((idea) =>
      idea.queries
        .slice(0, MAX_IDEA_QUERIES)
        .map((query) => ({ query, topic: "news" as const, hint: `idea: ${idea.perspective}`, proposed: true })),
    ),
  };
}

/**
 * Each competitor and business named on the command line, searched for by its name as typed (in
 * the user's language) and, with --news-site, only on those sites. Offered, never picked for the user.
 */
export function watchQueries(watch: Watchlist): QuerySuggestion[] {
  const on = watch.newsSites.length > 0 ? ` on ${watch.newsSites.join(", ")}` : "";
  const named = (names: string[], kind: string) =>
    names.map((query) => ({
      query,
      topic: "news" as const,
      hint: `${kind}${on}`,
      ...(watch.newsSites.length > 0 && { includeDomains: watch.newsSites }),
    }));
  return [...named(watch.competitors, "competitor"), ...named(watch.adopters, "adopter")];
}
