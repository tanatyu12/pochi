import * as clack from "@clack/prompts";
import { ExitCode, PochiError } from "../errors.js";

export interface TextPrompt {
  message: string;
  placeholder?: string;
  initialValue?: string;
  /** Returns an error message to reject the input. */
  validate?: (value: string) => string | undefined;
}

export interface SelectPrompt<T> {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue?: T;
}

export interface MultiselectPrompt<T> {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValues?: T[];
}

export interface ConfirmPrompt {
  message: string;
  initialValue?: boolean;
}

/**
 * The interactive surface of `pochi init`, so tests can script the answers.
 * Input methods throw PromptCancelled when the user cancels (Ctrl-C or Esc).
 */
export interface Prompter {
  text(prompt: TextPrompt): Promise<string>;
  select<T extends string>(prompt: SelectPrompt<T>): Promise<T>;
  /** May return an empty list: choosing nothing is an answer. */
  multiselect<T extends string>(prompt: MultiselectPrompt<T>): Promise<T[]>;
  confirm(prompt: ConfirmPrompt): Promise<boolean>;
  intro(title: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  warn(message: string): void;
  /** Shows a spinner with message while run settles, and passes on its result or error. */
  spin<T>(message: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export class PromptCancelled extends PochiError {
  constructor() {
    super("init cancelled; nothing was written", ExitCode.INTERRUPTED);
  }
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled.");
    throw new PromptCancelled();
  }
  return value as Exclude<T, symbol>;
}

export function createClackPrompter(): Prompter {
  return {
    async text({ validate, ...rest }) {
      // clack passes undefined for an untouched field.
      return unwrap(await clack.text({ ...rest, ...(validate && { validate: (v) => validate(v ?? "") }) }));
    },
    async select(prompt) {
      // clack's Option<T> is a conditional type, so it only resolves for a concrete T.
      return unwrap(await clack.select<string>(prompt)) as typeof prompt.options[number]["value"];
    },
    async multiselect(prompt) {
      return unwrap(await clack.multiselect<string>({ ...prompt, required: false })) as typeof prompt.options[number]["value"][];
    },
    async confirm(prompt) {
      return unwrap(await clack.confirm(prompt));
    },
    intro: (title) => clack.intro(title),
    outro: (message) => clack.outro(message),
    note: (message, title) => clack.note(message, title),
    warn: (message) => clack.log.warn(message),
    async spin(message, run, signal) {
      // On an abort the spinner stops itself with a cancel message; stop is then a no-op.
      const s = clack.spinner({ signal });
      s.start(message);
      try {
        const result = await run();
        s.stop(message);
        return result;
      } catch (err) {
        s.error(message);
        throw err;
      }
    },
  };
}
