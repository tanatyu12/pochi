import { type Prompter, PromptBack } from "./prompter.js";

type Kind = "text" | "select" | "multiselect" | "confirm";

interface Answered {
  kind: Kind;
  message: string;
  answer: unknown;
}

export interface ReplayingPrompter extends Prompter {
  /**
   * Called when a question threw PromptBack: the next run replays every answer before the one
   * before it, then asks that one again with its answer as the default.
   */
  back(): void;
}

/**
 * Lets a flow written as one straight run of questions go back a question. Every answer is
 * recorded; on PromptBack the caller runs the flow again from the start, and the answers before
 * the question to ask again come back at once, with nothing shown, so the flow takes the same
 * path to it. Whatever the flow fetches or asks a model must be cached by the caller, as a replay
 * repeats it.
 */
export function replayingPrompter(inner: Prompter): ReplayingPrompter {
  const log: Answered[] = [];
  let cursor = 0;
  // Answers below this index are replayed; the one at it is asked with its old answer as default.
  let replayUntil = 0;
  let again: { index: number; answer: unknown } | undefined;
  let frozen = false;
  let introduced = false;
  const replaying = () => cursor < replayUntil;

  async function ask<T>(kind: Kind, message: string, call: (previous: unknown) => Promise<T>): Promise<T> {
    const index = cursor++;
    if (index < replayUntil) {
      const recorded = log[index];
      if (recorded?.kind === kind && recorded.message === message) return recorded.answer as T;
      // The flow took another path (a fetch that now fails, say): ask from here on.
      replayUntil = index;
    }
    const previous = again?.index === index ? again.answer : undefined;
    for (;;) {
      try {
        const answer = await call(previous);
        log.length = index;
        log.push({ kind, message, answer });
        again = undefined;
        return answer;
      } catch (err) {
        // Once the answers have been acted on, there is nothing to go back to: ask the same again.
        if (err instanceof PromptBack && frozen) continue;
        if (err instanceof PromptBack) cursor = index;
        throw err;
      }
    }
  }

  return {
    text: (prompt) =>
      ask("text", prompt.message, (prev) =>
        inner.text(typeof prev === "string" ? { ...prompt, initialValue: prev } : prompt),
      ),
    select: (prompt) =>
      ask("select", prompt.message, (prev) =>
        inner.select(prev !== undefined ? { ...prompt, initialValue: prev as typeof prompt.initialValue } : prompt),
      ),
    multiselect: (prompt) =>
      ask("multiselect", prompt.message, (prev) =>
        inner.multiselect(Array.isArray(prev) ? { ...prompt, initialValues: prev as typeof prompt.initialValues } : prompt),
      ),
    confirm: (prompt) =>
      ask("confirm", prompt.message, (prev) =>
        inner.confirm(typeof prev === "boolean" ? { ...prompt, initialValue: prev } : prompt),
      ),
    // What a replay shows was on screen already.
    // The title stays at the top of the screen; going back to the first question does not repeat it.
    intro: (title) => {
      if (introduced) return;
      introduced = true;
      inner.intro(title);
    },
    outro: (message) => void (replaying() || inner.outro(message)),
    note: (message, title) => void (replaying() || inner.note(message, title)),
    warn: (message) => void (replaying() || inner.warn(message)),
    spin: (message, run, signal) => (replaying() ? run() : inner.spin(message, run, signal)),
    freeze: () => {
      frozen = true;
      inner.freeze?.();
    },
    back() {
      // On the first question there is nothing before it: it is asked again.
      const target = Math.max(0, cursor - 1);
      again = log[target] && { index: target, answer: log[target].answer };
      replayUntil = target;
      log.length = target;
      cursor = 0;
    },
  };
}
