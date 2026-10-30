import { Command } from "commander";
import { inspectState, resolveStatePath } from "../state/store.js";
import { greeting, isFancy, SITTING, WAGGING } from "../util/pochi-art.js";
import { plural } from "../util/text.js";
import { sleep } from "../util/time.js";

const WAGS = 6;
const WAG_MS = 160;

/** Replaced in tests; the defaults are the real ones. */
export interface WoofDeps {
  write?: (s: string) => void;
  /** Whether to draw; defaults to whether stdout is a terminal that shows color. */
  fancy?: boolean;
  statePath?: string;
  wagMs?: number;
}

/** Pochi wags its tail and says how many briefings it has fetched. Not in --help. */
export async function woof(deps: WoofDeps = {}): Promise<void> {
  const write = deps.write ?? ((s: string) => void process.stdout.write(s));
  const subtitle = await countText(deps.statePath ?? resolveStatePath());
  if (!(deps.fancy ?? isFancy())) {
    write(`Woof. ${subtitle}\n`);
    return;
  }
  const frame = (sprite: readonly string[]) => greeting({ subtitle, sprite });
  const height = frame(SITTING).split("\n").length - 1;
  write("\x1b[?25l");
  try {
    write(frame(SITTING));
    for (let i = 1; i <= WAGS; i++) {
      await sleep(deps.wagMs ?? WAG_MS);
      // Back to the top of the drawing, then over it.
      write(`\x1b[${height}A\r${frame(i % 2 === 1 ? WAGGING : SITTING)}`);
    }
  } finally {
    write("\x1b[?25h");
  }
}

// Only read: woof never moves aside or rewrites a state file.
async function countText(path: string): Promise<string> {
  const found = await inspectState(path).catch(() => undefined);
  const n = found?.kind === "ok" ? (found.state.briefings ?? 0) : 0;
  return n > 0 ? `${plural(n, "briefing")} fetched so far` : "a daily briefing for your project";
}

export function woofCommand(): Command {
  return new Command("woof").action(() => woof());
}
