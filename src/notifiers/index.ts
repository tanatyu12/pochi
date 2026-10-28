import { ConfigError } from "../config/load.js";
import type { Context } from "../config/schema.js";
import { fileNotifier } from "./file.js";
import { slackNotifier } from "./slack.js";
import type { Notifier } from "./types.js";

/**
 * One notifier per configured channel, in the order of context.notify.channels. Throws a
 * ConfigError (2) when a channel is missing what it needs, so run can stop before it fetches or
 * pays for anything.
 */
export function createNotifiers(
  context: Context,
  opts: { env?: NodeJS.ProcessEnv; slackIntervalMs?: number } = {},
): Notifier[] {
  const env = opts.env ?? process.env;
  const { postWhenEmpty } = context.notify;
  return context.notify.channels.map((channel) => {
    switch (channel.type) {
      case "slack": {
        // Actions expands an unset secret to "", so blank counts as unset.
        const webhookUrl = env.SLACK_WEBHOOK_URL?.trim();
        if (!webhookUrl) {
          throw new ConfigError(
            "SLACK_WEBHOOK_URL is not set (set notify.channels in context.yml to deliver elsewhere, or use --dry-run)",
          );
        }
        return slackNotifier(webhookUrl, { postWhenEmpty, intervalMs: opts.slackIntervalMs });
      }
      case "file":
        return fileNotifier({ dir: channel.dir, postWhenEmpty });
    }
  });
}
