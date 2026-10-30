import { styleText } from "node:util";

/**
 * Pochi the shiba, drawn on the terminal. Only for a terminal that shows color: logs, reports
 * and anything piped stay plain. POCHI_PLAIN (any value) turns it off, as NO_COLOR does.
 */
export function isFancy(
  stream: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(stream.isTTY) && !env.NO_COLOR && !env.POCHI_PLAIN;
}

// A light purple, as a 256-color code since Terminal.app has no truecolor.
const COAT = 183;

/** Text in Pochi's color. */
export function purple(text: string): string {
  return `\x1b[38;5;${COAT}m${text}\x1b[0m`;
}

/**
 * Sitting, facing right, as a silhouette. What makes it a dog rather than a fox: the step from
 * forehead to a blunt snout, the line of the mouth, the collar (the gap at the neck) and the tail
 * curled over the back.
 */
export const SITTING: readonly string[] = [
  "..............ss..ss....",
  "..............sss.sss...",
  "..............sssssss...",
  ".............ssssssss...",
  ".............ssssssss...",
  ".............sssssssssss",
  ".............sssssssssss",
  ".............ssssssss.s.",
  "..............sssssss...",
  "...............sssss....",
  "........................",
  ".....sss.......sssss....",
  "....s...s.....ssssss....",
  "....s..ss....sssssss....",
  ".....ssssssssssssssss...",
  "......sssssssssssssss...",
  "......ssssssssssss.ss...",
  "......sssssssssss..ss...",
  "......sssssssssss..ss...",
  "......ssssssssss...ss...",
  ".....ssssssssss...sss...",
];

/** SITTING with the tail swung up over the back; the two in turn make it wag. */
export const WAGGING: readonly string[] = [
  ...SITTING.slice(0, 10),
  ".......sss..............",
  "......s...s....sssss....",
  "......s..ss...ssssss....",
  ".......sss...sssssss....",
  "......sssssssssssssss...",
  ...SITTING.slice(15),
];

/**
 * One terminal line per two rows of pixels ("▀", "▄" or "█"), so a pixel is about as wide as it
 * is tall.
 */
export function renderSprite(rows: readonly string[]): string[] {
  const width = Math.max(...rows.map((r) => r.length));
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = (rows[y]?.[x] ?? ".") !== ".";
      const bottom = (rows[y + 1]?.[x] ?? ".") !== ".";
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(purple(line));
  }
  return lines;
}

/** Pochi beside the name and a line under it, by default what it does. */
export function greeting(opts: { subtitle?: string; sprite?: readonly string[] } = {}): string {
  const lines = renderSprite(opts.sprite ?? SITTING);
  lines[5] += `   ${styleText("bold", "pochi")}`;
  lines[6] += `   ${styleText("dim", opts.subtitle ?? "a daily briefing for your project")}`;
  return `\n${lines.map((l) => `  ${l}`).join("\n")}\n`;
}
