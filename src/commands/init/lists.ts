import type { ProposedText } from "../../proposal/parse.js";
import type { Prompter } from "../../util/prompter.js";
import { displayLine } from "../../util/text.js";
import { once } from "./keys.js";
import { HINT_MAX_CHARS, SHOWN_MAX_CHARS } from "./session.js";

// The proposed entries come first, all picked, so accepting the proposal is one keypress;
// more can be typed after them, which is asked about so Enter does not seem to skip that.
export async function askListWithProposals(
  p: Prompter,
  proposed: readonly ProposedText[],
  opts: { message: string; placeholder: string; min: number; max: number },
): Promise<string[]> {
  const seen = new Set<string>();
  const unique = proposed.filter((e) => once(seen, e.text.toLowerCase())).slice(0, opts.max);
  if (unique.length === 0) return askList(p, opts);
  const picked = await p.multiselect({
    message: `${opts.message} (proposed; space to toggle, enter to confirm)`,
    options: unique.map((e) => ({
      value: e.text,
      label: displayLine(e.text, SHOWN_MAX_CHARS),
      hint: displayLine(e.evidence, HINT_MAX_CHARS) || undefined,
    })),
    initialValues: unique.map((e) => e.text),
  });
  if (picked.length >= opts.max) return picked;
  const min = Math.max(0, opts.min - picked.length);
  if (min > 0) p.note(`Add at least ${min} of your own.`);
  else if (!(await askAddOwn(p, picked.length))) return picked;
  const typed = await askList(p, { ...opts, min, max: opts.max - picked.length, taken: picked });
  return [...picked, ...typed];
}

export function askAddOwn(p: Prompter, picked: number): Promise<boolean> {
  return p.confirm({ message: `Add your own as well? (${picked} picked)`, initialValue: false });
}

// One text prompt per entry; an empty answer ends the list once min entries are in. An entry
// already in the list, or in taken, is refused whatever its case.
export async function askList(
  p: Prompter,
  opts: { message: string; placeholder: string; min: number; max: number; taken?: readonly string[] },
): Promise<string[]> {
  const items: string[] = [];
  const seen = new Set((opts.taken ?? []).map((t) => t.toLowerCase()));
  while (items.length < opts.max) {
    const mandatory = items.length < opts.min;
    const answer = await p.text({
      message: `${opts.message} (${items.length + 1}/${opts.max}${mandatory ? "" : ", empty to finish"})`,
      placeholder: opts.placeholder,
      validate: (v) => {
        if (mandatory && required(v)) return required(v);
        return seen.has(v.trim().toLowerCase()) ? "Already in the list" : undefined;
      },
    });
    seen.add(answer.trim().toLowerCase());
    if (answer.trim() === "") break;
    items.push(answer.trim());
  }
  return items;
}

export function required(value: string): string | undefined {
  return value.trim() === "" ? "Required" : undefined;
}
