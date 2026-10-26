import type { Impact } from "../config/schema.js";
import type { Finding } from "../types.js";
import { HttpError, postJson } from "../util/http.js";
import { log } from "../util/log.js";
import { truncate } from "../util/text.js";
import { sleep } from "../util/time.js";

export const MAX_ITEMS_PER_MESSAGE = 45;
/** Slack allows 3000 per section; the margin covers counting differences. */
export const MAX_SECTION_CHARS = 2900;
/** Slack's limit per message: header + 45 sections + context stays under it. */
export const MAX_BLOCKS = 50;

const MAX_HEADER_CHARS = 150;
const MAX_CONTEXT_CHARS = 3000;
const MAX_TITLE_CHARS = 300;
const MAX_SOURCE_CHARS = 200;
const SEND_INTERVAL_MS = 1_100;

// Labels are English whatever the configured language; only the model's text follows it.
const EMOJI: Record<Impact, string> = {
  High: ":red_circle:",
  Medium: ":large_orange_circle:",
  Low: ":large_blue_circle:",
};

export interface Briefing {
  /** context.project.name */
  project: string;
  /** "2026-10-26" */
  date: string;
  /** In the order filter left them (impact, then date). */
  findings: Finding[];
  /** Items collected. */
  collected: number;
  /** Sources fetched. */
  attempted: number;
  /** Names of the sources that failed. */
  failedSources: string[];
}

export interface SlackMessage {
  payload: { text: string; blocks: unknown[] };
  /** Item.id of every finding in this message. */
  itemIds: string[];
}

export interface SlackFailure {
  index: number;
  /** For a message not sent because an earlier one failed, the error that stopped sending. */
  error: unknown;
}

export interface SlackResult {
  /** Item.id of the findings in messages that got a 2xx. */
  deliveredIds: string[];
  sent: number;
  /** Messages not delivered, including those never sent. */
  failures: SlackFailure[];
}

/** Slack's control characters; & first so an escaped &lt; is not escaped again. */
export function escapeMrkdwn(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The messages to post, in order. Empty when there is nothing to say and postWhenEmpty is off.
 * Pure, so a dry run can print exactly what would be sent.
 */
export function buildSlackMessages(b: Briefing, opts: { postWhenEmpty: boolean }): SlackMessage[] {
  const context = contextBlock(b);
  if (b.findings.length === 0) {
    if (!opts.postWhenEmpty) return [];
    return [
      {
        payload: {
          text: `Pochi: no relevant updates for ${escapeMrkdwn(b.project)}`,
          blocks: [headerBlock(b, ""), mrkdwnSection("No relevant updates today."), context],
        },
        itemIds: [],
      },
    ];
  }

  const chunks: Finding[][] = [];
  for (let i = 0; i < b.findings.length; i += MAX_ITEMS_PER_MESSAGE) {
    chunks.push(b.findings.slice(i, i + MAX_ITEMS_PER_MESSAGE));
  }
  const high = b.findings.filter((f) => f.impact === "High").length;
  const summary =
    `Pochi: ${plural(b.findings.length, "update")} for ${escapeMrkdwn(b.project)}` + (high > 0 ? ` (${high} High)` : "");
  return chunks.map((chunk, i) => {
    const part = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "";
    return {
      payload: {
        text: summary + part,
        blocks: [headerBlock(b, part), ...chunk.map((f) => mrkdwnSection(findingText(f))), context],
      },
      itemIds: chunk.map((f) => f.item.id),
    };
  });
}

/**
 * Posts the messages in order, 1.1s apart. Does not throw on delivery failures (the caller
 * decides the exit code from the result), only when the signal aborts.
 *
 * A 400 is a problem with that payload, so the next message is still tried. Any other failure
 * (a dead webhook, 429 or 5xx after the retries, a network error) stops sending.
 */
export async function sendSlack(
  webhookUrl: string,
  messages: SlackMessage[],
  opts: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<SlackResult> {
  const result: SlackResult = { deliveredIds: [], sent: 0, failures: [] };
  for (const [index, message] of messages.entries()) {
    if (index > 0) await sleep(opts.intervalMs ?? SEND_INTERVAL_MS, opts.signal);
    const label = `Slack message ${index + 1}/${messages.length}`;
    try {
      // Slack may have posted a message that failed with a 5xx, but one retry is worth a rare duplicate.
      await postJson(webhookUrl, message.payload, { signal: opts.signal, retry: { rateLimit: 3, server: 1 } });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      log.warn(`${label} was not delivered`, err);
      result.failures.push({ index, error: err });
      if (err instanceof HttpError && err.status === 400) continue;
      const rest = messages.length - index - 1;
      if (rest > 0) log.warn(`skipped the remaining ${plural(rest, "Slack message")}`);
      for (let i = index + 1; i < messages.length; i++) result.failures.push({ index: i, error: err });
      break;
    }
    log.debug(`${label} delivered`);
    result.sent++;
    result.deliveredIds.push(...message.itemIds);
  }
  return result;
}

function headerBlock(b: Briefing, part: string): unknown {
  // plain_text is not parsed, so no escaping.
  const text = truncate(`Pochi · ${b.project} · ${b.date}`, MAX_HEADER_CHARS - part.length) + part;
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function mrkdwnSection(text: string): unknown {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function contextBlock(b: Briefing): unknown {
  let text = `Collected ${plural(b.collected, "item")} from ${plural(b.attempted, "source")}`;
  if (b.failedSources.length > 0) {
    const prefix = " · Failed: ";
    text += prefix + fitEscaped(b.failedSources.join(", "), MAX_CONTEXT_CHARS - text.length - prefix.length);
  }
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** One finding as a section, within MAX_SECTION_CHARS: the summary is cut first, then the action. */
function findingText(f: Finding): string {
  // "|" ends the link label and the URL, so neither may contain one.
  const url = escapeMrkdwn(f.item.url.replaceAll("|", "%7C"));
  const title = fitEscaped(f.title.replaceAll("|", "｜"), MAX_TITLE_CHARS);
  const head = `${EMOJI[f.impact]} *[${f.impact}]* <${url}|${title}>`;
  const source = `_${fitEscaped(f.item.sourceName, MAX_SOURCE_CHARS)}_`;
  const actionPrefix = "*Action:* ";
  const hasAction = f.action.trim() !== "";
  const newlines = hasAction ? 3 : 2;
  const rest =
    MAX_SECTION_CHARS - head.length - source.length - newlines - (hasAction ? actionPrefix.length : 0);
  // The action keeps at least half of the room, or all that the summary leaves.
  const action = hasAction
    ? fitEscaped(f.action, Math.max(Math.floor(rest / 2), rest - escapeMrkdwn(f.summary).length))
    : "";
  const summary = fitEscaped(f.summary, rest - action.length);
  return [head, summary, ...(hasAction ? [actionPrefix + action] : []), source].join("\n");
}

/**
 * Escaped text no longer than maxChars (UTF-16 units, which over-count rather than under-count),
 * cut by code point and never inside an entity, with "…" when cut.
 */
function fitEscaped(raw: string, maxChars: number): string {
  const full = escapeMrkdwn(raw);
  if (full.length <= maxChars) return full;
  if (maxChars <= 0) return "";
  let out = "";
  for (const ch of raw) {
    const escaped = escapeMrkdwn(ch);
    if (out.length + escaped.length + 1 > maxChars) break;
    out += escaped;
  }
  return `${out.trimEnd()}…`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
