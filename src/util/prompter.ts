import { emitKeypressEvents } from "node:readline";
import { styleText } from "node:util";
import * as clack from "@clack/prompts";
import { ExitCode, PochiError } from "../errors.js";
import { configureLog } from "./log.js";

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

const FRAMES = clack.unicode ? ["◒", "◐", "◓", "◑"] : ["•", "o", "O", "0"];
const FRAME_MS = 80;

/**
 * Shows message beside a spinner until the returned function is called. Not clack's spinner:
 * its keypress handler (@clack/core block) exits with 0 on Ctrl-C, so a cancelled fetch would
 * look like a success. Here Ctrl-C emits SIGINT in the process, as Ctrl-C does outside raw
 * mode; emitting rather than signalling also reaches the handler on Windows. Other keys do nothing.
 */
function startSpinner(message: string): () => void {
  const input = process.stdin;
  const output = process.stdout;
  const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
    if (str === "\x03" || (key?.ctrl && key.name === "c")) process.emit("SIGINT");
  };
  input.on("keypress", onKeypress);
  // Raw mode keeps typed keys off the spinner line and turns Ctrl-C into a key. A prompt that
  // finished left the input paused.
  if (input.isTTY) {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
  }

  let timer: NodeJS.Timeout | undefined;
  if (output.isTTY) {
    // One line, so a carriage return redraws it. A terminal that reports no size gets it whole.
    const width = output.columns || Infinity;
    const shown = message.length + 3 > width ? `${message.slice(0, Math.max(0, width - 4))}…` : message;
    let frame = 0;
    const draw = () => output.write(`\r\x1b[2K${styleText("magenta", FRAMES[frame++ % FRAMES.length]!)}  ${shown}`);
    output.write("\x1b[?25l");
    draw();
    timer = setInterval(draw, FRAME_MS);
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    input.off("keypress", onKeypress);
    // Paused so the process can exit; the next prompt resumes it.
    if (input.isTTY) {
      input.setRawMode(false);
      input.pause();
    }
    if (timer) {
      clearInterval(timer);
      output.write("\r\x1b[2K\x1b[?25h");
    }
  };
}

/**
 * Makes a full-width space (U+3000), which Space types while a Japanese IME is on, toggle like a
 * space: clack goes by key names, and that keypress has none. Returns the function that undoes it.
 */
function fullWidthSpaceAsSpace(input: NodeJS.ReadStream): () => void {
  const onKeypress = (str: string | undefined) => {
    if (str === "\u3000") input.emit("keypress", " ", { name: "space", sequence: " " });
  };
  input.on("keypress", onKeypress);
  return () => void input.off("keypress", onKeypress);
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
      // Listened to after clack, which subscribes as the prompt starts, so clack sees the space it emits.
      const answer = clack.multiselect<string>({ ...prompt, required: false });
      const restore = fullWidthSpaceAsSpace(process.stdin);
      try {
        return unwrap(await answer) as typeof prompt.options[number]["value"][];
      } finally {
        restore();
      }
    },
    async confirm(prompt) {
      return unwrap(await clack.confirm(prompt));
    },
    intro: (title) => clack.intro(title),
    outro: (message) => clack.outro(message),
    note: (message, title) => clack.note(message, title),
    warn: (message) => clack.log.warn(message),
    async spin(message, run, signal) {
      // Log lines written over the spinner would be redrawn into a mess; they are shown after it.
      const held: string[] = [];
      const restoreLog = configureLog({ write: (line) => void held.push(line) });
      const stop = startSpinner(message);
      try {
        const result = await run();
        stop();
        clack.log.step(message);
        return result;
      } catch (err) {
        stop();
        clack.log.error(signal?.aborted ? `${message}: cancelled` : message);
        throw err;
      } finally {
        stop();
        restoreLog();
        for (const line of held) clack.log.warn(line.trimEnd().replace(/^pochi: \w+: /, ""));
      }
    },
  };
}
