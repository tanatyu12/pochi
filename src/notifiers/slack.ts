import type { Impact } from "../config/schema.js";
import type { Insight } from "../types.js";
import { HttpError, postJson } from "../util/http.js";
import { log } from "../util/log.js";
import { collapseWhitespace, plural, truncate, truncateUnits } from "../util/text.js";
import { sleep } from "../util/time.js";
import { relatedShown } from "./text.js";
import type { Briefing, Delivery, DeliveryFailure, Notifier } from "./types.js";

export const MAX_ITEMS_PER_MESSAGE = 45;
/** Slack allows 3000 per section; the margin covers counting differences. */
export const MAX_SECTION_CHARS = 2900;
/**
 * Section text per message. Slack documents no total, but payloads of about 13,000 characters
 * have been reported to vanish, so a message stays well below that.
 */
export const MAX_MESSAGE_CHARS = 12_000;
/** Slack's limit per message: header + 45 sections + context stays under it. */
export const MAX_BLOCKS = 50;
/** Escaped. A longer URL loses its query, and then its link. */
export const MAX_URL_CHARS = 1000;
/** Extra posts allowed for retrying rejected messages in smaller pieces, per sendSlack. */
export const MAX_FALLBACK_POSTS = 20;

const MAX_HEADER_CHARS = 150;
const MAX_CONTEXT_CHARS = 3000;
const MAX_TITLE_CHARS = 300;
const MAX_SOURCE_CHARS = 200;
const MAX_RELATED_TITLE_CHARS = 80;
/** The other reports of a story; links that do not fit are only counted. */
const MAX_RELATED_CHARS = 900;
const SEND_INTERVAL_MS = 1_100;

// Labels are English whatever the configured language; only the model's text follows it.
const EMOJI: Record<Impact, string> = {
  High: ":red_circle:",
  Medium: ":large_orange_circle:",
  Low: ":large_blue_circle:",
};

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export interface SlackMessage {
  payload: { text: string; blocks: unknown[] };
  /** Item.id of every insight in this message. */
  itemIds: string[];
  /**
   * What to post instead when Slack rejects this payload with a 400: the two halves, and for a
   * single insight a bare entry without the link, summary and action.
   */
  fallback?: () => SlackMessage[];
}

export interface SlackFailure extends DeliveryFailure {
  /** Index of the message passed to sendSlack. */
  index: number;
}

/** deliveredIds are the insights in messages that got a 2xx. */
export interface SlackResult extends Delivery {
  failures: SlackFailure[];
}

/** Builds the messages when it delivers, so a dry run can print the same ones with buildSlackMessages. */
export function slackNotifier(
  webhookUrl: string,
  opts: { postWhenEmpty: boolean; intervalMs?: number },
): Notifier {
  return {
    name: "slack",
    deliver: (b, { signal }) =>
      sendSlack(webhookUrl, buildSlackMessages(b, opts), { signal, intervalMs: opts.intervalMs }),
  };
}

/** Slack's control characters, in one pass so an escaped &lt; is not escaped again. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/[&<>]/g, (ch) => ENTITIES[ch]!);
}

/**
 * The messages to post, in order. Empty when there is nothing to say and postWhenEmpty is off.
 * Pure, so a dry run can print exactly what would be sent.
 */
export function buildSlackMessages(b: Briefing, opts: { postWhenEmpty: boolean }): SlackMessage[] {
  const context = contextBlock(b);
  if (b.insights.length === 0) {
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

  // A message ends at 45 insights or before its sections would pass MAX_MESSAGE_CHARS.
  const texts = b.insights.map(insightText);
  const ranges: [number, number][] = [];
  let start = 0;
  let chars = 0;
  for (const [i, text] of texts.entries()) {
    if (i > start && (i - start === MAX_ITEMS_PER_MESSAGE || chars + text.length > MAX_MESSAGE_CHARS)) {
      ranges.push([start, i]);
      start = i;
      chars = 0;
    }
    chars += text.length;
  }
  ranges.push([start, texts.length]);

  const high = b.insights.filter((f) => f.impact === "High").length;
  const summary =
    `Pochi: ${plural(b.insights.length, "update")} for ${escapeMrkdwn(b.project)}` + (high > 0 ? ` (${high} High)` : "");
  return ranges.map(([from, to], i) => {
    const part = ranges.length > 1 ? ` (${i + 1}/${ranges.length})` : "";
    const frame = { text: summary + part, header: headerBlock(b, part), context };
    return insightsMessage(frame, b.insights.slice(from, to), texts.slice(from, to));
  });
}

/**
 * Posts the messages in order, 1.1s apart. Never throws: the caller decides the exit code and
 * what to mark notified from the result, also after an abort.
 *
 * A 400 is a problem with that payload, so its fallback is posted in its place (within
 * MAX_FALLBACK_POSTS) and the next message is still tried. Any other failure (a dead webhook,
 * 429 or 5xx after the retries, a network error) stops sending.
 */
export async function sendSlack(
  webhookUrl: string,
  messages: SlackMessage[],
  opts: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<SlackResult> {
  const result: SlackResult = { deliveredIds: [], failures: [], aborted: false };
  const queue = messages.map((message, index) => ({ message, index }));
  const fail = (entries: typeof queue, error: unknown) => {
    for (const { message, index } of entries) result.failures.push({ index, itemIds: message.itemIds, error });
  };
  let fallbackPosts = 0;
  let posted = false;
  for (let entry = queue.shift(); entry; entry = queue.shift()) {
    const { message, index } = entry;
    const label = `Slack message ${index + 1}/${messages.length}`;
    try {
      if (posted) await sleep(opts.intervalMs ?? SEND_INTERVAL_MS, opts.signal);
      posted = true;
      // Slack may have posted a message that failed with a 5xx, but one retry is worth a rare duplicate.
      await postJson(webhookUrl, message.payload, { signal: opts.signal, retry: { rateLimit: 3, server: 1 } });
    } catch (err) {
      if (opts.signal?.aborted) {
        result.aborted = true;
        fail([entry, ...queue], err);
        break;
      }
      log.warn(`${label} was not delivered`, err);
      if (err instanceof HttpError && err.status === 400) {
        const pieces = message.fallback?.() ?? [];
        if (pieces.length > 0 && fallbackPosts + pieces.length <= MAX_FALLBACK_POSTS) {
          fallbackPosts += pieces.length;
          log.info(`retrying ${label} as ${plural(pieces.length, "smaller message")}`);
          queue.unshift(...pieces.map((piece) => ({ message: piece, index })));
        } else {
          fail([entry], err);
        }
        continue;
      }
      fail([entry], err);
      if (queue.length > 0) log.warn(`skipped the remaining ${plural(queue.length, "Slack message")}`);
      fail(queue, err);
      break;
    }
    log.debug(`${label} delivered`);
    result.deliveredIds.push(...message.itemIds);
  }
  return result;
}

interface Frame {
  text: string;
  header: unknown;
  context: unknown;
}

function insightsMessage(frame: Frame, insights: Insight[], texts: string[]): SlackMessage {
  return {
    payload: { text: frame.text, blocks: [frame.header, ...texts.map(mrkdwnSection), frame.context] },
    itemIds: insights.map((f) => f.item.id),
    fallback: () => {
      if (insights.length > 1) {
        const mid = Math.ceil(insights.length / 2);
        return [
          insightsMessage(frame, insights.slice(0, mid), texts.slice(0, mid)),
          insightsMessage(frame, insights.slice(mid), texts.slice(mid)),
        ];
      }
      const f = insights[0]!;
      const bare = `${impactLabel(f)} *${fitEscaped(collapseWhitespace(f.title), MAX_TITLE_CHARS)}*\n${sourceText(f)}`;
      return [{ payload: { text: frame.text, blocks: [frame.header, mrkdwnSection(bare), frame.context] }, itemIds: [f.item.id] }];
    },
  };
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

/** One insight as a section, within MAX_SECTION_CHARS: the summary is cut first, then the action. */
function insightText(f: Insight): string {
  // "|" ends the link label, so the title may not contain one.
  const title = fitEscaped(collapseWhitespace(f.title).replaceAll("|", "｜"), MAX_TITLE_CHARS);
  const url = linkUrl(f.item.url);
  const head = `${impactLabel(f)} ${url === undefined ? `*${title}*` : `<${url}|${title}>`}`;
  const source = sourceText(f);
  const related = relatedLine(f);
  const actionPrefix = "*Action:* ";
  const summary = escapeUnits(f.summary.trim());
  const action = escapeUnits(f.action.trim());
  const lines = 2 + (summary.length > 0 ? 1 : 0) + (action.length > 0 ? 1 : 0) + (related ? 1 : 0);
  const rest = Math.max(
    0,
    MAX_SECTION_CHARS -
      head.length -
      source.length -
      related.length -
      (lines - 1) -
      (action.length > 0 ? actionPrefix.length : 0),
  );
  // The action keeps at least half of the room, or all that the summary leaves.
  const actionText =
    action.length > 0 ? truncateUnits(action, Math.max(Math.floor(rest / 2), rest - summary.join("").length)) : "";
  const summaryText = truncateUnits(summary, rest - actionText.length);
  return [head, summaryText, actionText && actionPrefix + actionText, source, related]
    .filter((s) => s !== "")
    .join("\n");
}

/** The other reports of a story, as many linked as fit in MAX_RELATED_CHARS; "" without any. */
function relatedLine(f: Insight): string {
  const { shown, more } = relatedShown(f);
  if (shown.length === 0) return "";
  const links = shown.map((r) => {
    const title = fitEscaped(collapseWhitespace(r.title).replaceAll("|", "｜"), MAX_RELATED_TITLE_CHARS);
    const url = linkUrl(r.url);
    return url === undefined ? title : `<${url}|${title}>`;
  });
  for (let n = links.length; ; n--) {
    const rest = more + links.length - n;
    const parts = [...links.slice(0, n), ...(rest > 0 ? [`and ${rest} more`] : [])];
    const line = `_Also:_ ${parts.join(" · ")}`;
    if (line.length <= MAX_RELATED_CHARS || n === 0) return line;
  }
}

function impactLabel(f: Insight): string {
  return `${EMOJI[f.impact]} *[${f.impact}]*`;
}

function sourceText(f: Insight): string {
  return `_${fitEscaped(collapseWhitespace(f.item.sourceName), MAX_SOURCE_CHARS)}_`;
}

/** The URL for a link, escaped; without its query when too long, undefined when still too long. */
function linkUrl(raw: string): string | undefined {
  // "|" ends the URL in a link.
  const escape = (u: string) => escapeMrkdwn(u.replaceAll("|", "%7C"));
  const full = escape(raw);
  if (full.length <= MAX_URL_CHARS) return full;
  let short: string;
  try {
    const u = new URL(raw);
    short = escape(u.origin + u.pathname);
  } catch {
    return undefined;
  }
  return short.length <= MAX_URL_CHARS ? short : undefined;
}

/** Escaped code points, so a cut never lands inside an entity. */
function escapeUnits(raw: string): string[] {
  return Array.from(raw, (ch) => ENTITIES[ch] ?? ch);
}

/** Escaped text no longer than maxChars (UTF-16 units, which over-count rather than under-count). */
function fitEscaped(raw: string, maxChars: number): string {
  return truncateUnits(escapeUnits(raw), maxChars);
}
