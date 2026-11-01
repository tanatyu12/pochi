import { styleText } from "node:util";

/**
 * Pochi the shiba, drawn on the terminal. Only for a terminal that shows color: logs, reports
 * and anything piped stay plain. POCHI_PLAIN (any value) turns it off, as NO_COLOR does.
 */
export function isFancy(stream: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR && !process.env.POCHI_PLAIN;
}

// A light purple, as a 256-color code since Terminal.app has no truecolor.
const COAT = 183;

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
      const top = (rows[y]![x] ?? ".") !== ".";
      const bottom = (rows[y + 1]?.[x] ?? ".") !== ".";
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`\x1b[38;5;${COAT}m${line}\x1b[0m`);
  }
  return lines;
}

/** Pochi beside the name and what it does. */
export function greeting(): string {
  const lines = renderSprite(SITTING);
  lines[5] += `   ${styleText("bold", "pochi")}`;
  lines[6] += `   ${styleText("dim", "a daily briefing for your project")}`;
  return `\n${lines.map((l) => `  ${l}`).join("\n")}\n`;
}
