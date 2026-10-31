import type { Insight } from "../types.js";

export interface Briefing {
  /** context.project.name */
  project: string;
  /** "2026-10-26" */
  date: string;
  /** In the order filter left them (impact, then date). */
  insights: Insight[];
  /** Items collected. */
  collected: number;
  /** Sources fetched. */
  attempted: number;
  /** Names of the sources that failed. */
  failedSources: string[];
}

export interface DeliveryFailure {
  /** Item.id of the insights that were not delivered. */
  itemIds: string[];
  /** For insights not sent because an earlier send failed, the error that stopped sending. */
  error: unknown;
}

export interface Delivery {
  /** Item.id of the insights that reached the channel. */
  deliveredIds: string[];
  /** Insights not delivered, including those never sent. */
  failures: DeliveryFailure[];
  /** The signal aborted; what was delivered before that is still in deliveredIds. */
  aborted: boolean;
}

/**
 * One place a briefing goes. deliver never throws: run decides the exit code and what to mark
 * notified from the result, also after an abort.
 */
export interface Notifier {
  /** The channel type, for logs, error messages and --json. */
  readonly name: string;
  deliver(b: Briefing, opts: { signal?: AbortSignal }): Promise<Delivery>;
}
