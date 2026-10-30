import { afterEach, describe, expect, it, vi } from "vitest";
import { isFancy, renderSprite, SITTING } from "../../src/util/pochiArt.js";

const tty = { isTTY: true } as NodeJS.WriteStream;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isFancy", () => {
  it("draws only on a terminal that shows color, and not with POCHI_PLAIN", () => {
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("POCHI_PLAIN", "");
    expect(isFancy(tty)).toBe(true);
    expect(isFancy({ isTTY: false } as NodeJS.WriteStream)).toBe(false);
    vi.stubEnv("POCHI_PLAIN", "1");
    expect(isFancy(tty)).toBe(false);
    vi.stubEnv("POCHI_PLAIN", "");
    vi.stubEnv("NO_COLOR", "1");
    expect(isFancy(tty)).toBe(false);
  });

  it("does read the env it is given instead of process.env", () => {
    vi.stubEnv("POCHI_PLAIN", "1");
    expect(isFancy(tty, {})).toBe(true);
    vi.stubEnv("POCHI_PLAIN", "");
    expect(isFancy(tty, { NO_COLOR: "1" })).toBe(false);
    expect(isFancy(tty, { POCHI_PLAIN: "yes" })).toBe(false);
  });
});

describe("renderSprite", () => {
  const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[\d;]*m/g, ""));

  it("puts two rows of pixels on each line", () => {
    const lines = plain(renderSprite(SITTING));
    expect(lines).toHaveLength(Math.ceil(SITTING.length / 2));
    const width = Math.max(...SITTING.map((r) => r.length));
    for (const line of lines) expect(line).toHaveLength(width);
  });

  it("picks the block from which pixels are set", () => {
    expect(plain(renderSprite(["s.s.", ".ss."]))).toEqual(["▀▄█ "]);
    expect(plain(renderSprite(["s"]))).toEqual(["▀"]);
  });
});
