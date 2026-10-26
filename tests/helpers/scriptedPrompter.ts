import { type Prompter, PromptCancelled } from "../../src/util/prompter.js";

/** An answer that cancels the prompt, as Ctrl-C would. */
export const CANCEL = Symbol("cancel");

export type Answer = string | boolean | typeof CANCEL;

export interface ScriptedPrompter extends Prompter {
  /** Messages of the input prompts asked so far. */
  readonly asked: string[];
  /** Everything shown by intro / outro / note / warn, as "kind: text". */
  readonly shown: string[];
  /** Answers not yet consumed. */
  readonly remaining: Answer[];
}

/**
 * Answers input prompts in order. Text answers go through the prompt's validate first, and a
 * rejected answer throws, so a test cannot slip a value past the validation the real UI enforces.
 */
export function scriptedPrompter(answers: Answer[]): ScriptedPrompter {
  const remaining = [...answers];
  const asked: string[] = [];
  const shown: string[] = [];

  function next(message: string): Answer {
    asked.push(message);
    if (remaining.length === 0) throw new Error(`no scripted answer for: ${message}`);
    const answer = remaining.shift()!;
    if (answer === CANCEL) throw new PromptCancelled();
    return answer;
  }

  return {
    asked,
    shown,
    remaining,
    async text({ message, validate }) {
      const answer = next(message);
      if (typeof answer !== "string") throw new Error(`expected a string answer for: ${message}`);
      const error = validate?.(answer);
      if (error !== undefined) throw new Error(`rejected "${answer}" for ${message}: ${error}`);
      return answer;
    },
    async select({ message, options }) {
      const answer = next(message);
      const option = options.find((o) => o.value === answer);
      if (!option) throw new Error(`"${String(answer)}" is not an option for: ${message}`);
      return option.value;
    },
    async confirm({ message }) {
      const answer = next(message);
      if (typeof answer !== "boolean") throw new Error(`expected a boolean answer for: ${message}`);
      return answer;
    },
    intro: (title) => void shown.push(`intro: ${title}`),
    outro: (message) => void shown.push(`outro: ${message}`),
    note: (message, title) => void shown.push(`note: ${title === undefined ? "" : `${title}: `}${message}`),
    warn: (message) => void shown.push(`warn: ${message}`),
  };
}
