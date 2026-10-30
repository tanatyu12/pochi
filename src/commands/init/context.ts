import { type ChannelConfig, type ContextInput, MAX_EXCLUDE, MAX_PROBLEMS } from "../../config/schema.js";
import type { Proposal } from "../../proposal/parse.js";
import type { Prompter } from "../../util/prompter.js";
import { plural } from "../../util/text.js";
import { askListWithProposals, required } from "./lists.js";

const LANGUAGES = ["English", "Japanese"] as const;

type ChannelInput = NonNullable<NonNullable<ContextInput["notify"]>["channels"]>[number];

const CHANNELS = [
  { value: "slack", label: "Slack", hint: "an incoming webhook in SLACK_WEBHOOK_URL" },
  { value: "file", label: "Markdown files", hint: "reports/<date>.md" },
] as const;

export function noteProposal(p: Prompter, proposal: Proposal): void {
  const counts = [
    plural(proposal.problems.length, "problem"),
    plural(proposal.exclude.length, "exclusion"),
    plural(proposal.repos.length, "repository", "repositories"),
    plural(proposal.sites.length, "site"),
    plural(proposal.queries.length, "query", "queries"),
  ];
  p.note(`${counts.join(", ")}.\nEach is offered to pick, and checked before anything is written.`, "Proposal");
  if (proposal.dropped > 0) {
    p.warn(`Left out ${plural(proposal.dropped, "proposed entry", "proposed entries")}: malformed or past the limits.`);
  }
}

export async function askContext(
  p: Prompter,
  proposal?: Proposal,
  previousChannels?: readonly ChannelConfig[],
): Promise<ContextInput> {
  const name = await p.text({
    message: "Project name",
    placeholder: "my-app",
    initialValue: proposal?.project.name || undefined,
    validate: required,
  });
  const description = await p.text({
    message: "Describe the project in a sentence or two (optional)",
    placeholder: "A Next.js SaaS app with a Postgres backend",
    initialValue: proposal?.project.description || undefined,
  });
  const problems = await askListWithProposals(p, proposal?.problems ?? [], {
    message: "What do you want to hear about?",
    placeholder: "Breaking changes in Next.js",
    min: 1,
    max: MAX_PROBLEMS,
  });
  const exclude = await askListWithProposals(p, proposal?.exclude ?? [], {
    message: "What should be dropped even if it looks related?",
    placeholder: "Funding news",
    min: 0,
    max: MAX_EXCLUDE,
  });
  const proposed = proposal?.language;
  const known = LANGUAGES.find((l) => l.toLowerCase() === proposed?.toLowerCase());
  const choice = await p.select({
    message: "Language for the summaries",
    options: [...LANGUAGES.map((l) => ({ value: l, label: l })), { value: "other", label: "Other" }],
    initialValue: known ?? (proposed ? "other" : "English"),
  });
  const language =
    choice === "other"
      ? (
          await p.text({
            message: "Language",
            placeholder: "German",
            initialValue: known ? undefined : proposed,
            validate: required,
          })
        ).trim()
      : choice;

  const channels = await askChannels(p, previousChannels);

  return {
    version: 1,
    project: { name: name.trim(), description: description.trim() },
    problems,
    ...(exclude.length > 0 && { exclude }),
    language,
    notify: { channels },
  };
}

/**
 * Asked again until one is picked: a run has to deliver somewhere. Starts from the channels set
 * before, or from files, which need no secret: Enter on another row keeps what is checked, so
 * a default that needs setting up would be picked by mistake.
 */
async function askChannels(p: Prompter, previous: readonly ChannelConfig[] = []): Promise<ChannelInput[]> {
  for (;;) {
    const picked = await p.multiselect({
      message: "Where should the briefing go? (space to toggle)",
      options: CHANNELS.map((c) => ({ ...c })),
      initialValues: previous.length > 0 ? previous.map((c) => c.type) : ["file"],
    });
    // A channel picked again keeps its settings, such as the reports dir.
    if (picked.length > 0) return picked.map((type) => previous.find((c) => c.type === type) ?? { type });
    p.warn("Pick at least one.");
  }
}
