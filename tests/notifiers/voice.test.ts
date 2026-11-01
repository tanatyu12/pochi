import { describe, expect, it } from "vitest";
import { buildSlackMessages } from "../../src/notifiers/slack.js";
import { toMarkdown, toText } from "../../src/notifiers/text.js";
import type { Briefing } from "../../src/notifiers/types.js";
import { QUIET_LINES, quietLine } from "../../src/notifiers/voice.js";

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    project: "my-app",
    date: "2026-10-26",
    insights: [],
    collected: 120,
    attempted: 8,
    failedSources: [],
    personality: true,
    ...overrides,
  };
}

describe("Pochi's voice", () => {
  it("signs every report", () => {
    const md = toMarkdown(briefing({ failedSources: ["Blog A"] }));
    expect(md).toMatch(/^# Pochi · my-app · 2026-10-26\n/);
    expect(md).toContain("Fetched by Pochi · 120 items from 8 sources; couldn't fetch: Blog A\n");
    expect(toText(briefing())).toContain("Fetched by Pochi · 120 items from 8 sources\n");

    const [m] = buildSlackMessages(briefing({ failedSources: ["Blog A"] }), { postWhenEmpty: true });
    const blocks = m!.payload.blocks as { text?: { text: string }; elements?: { text: string }[] }[];
    expect(blocks[0]!.text!.text).toBe("Pochi · my-app · 2026-10-26");
    expect(blocks.at(-1)!.elements![0]!.text).toBe("Fetched by Pochi · 120 items from 8 sources · Couldn't fetch: Blog A");
  });

  it("says the same quiet-day line in every report of a day", () => {
    const line = quietLine(briefing())!;
    expect(QUIET_LINES).toContain(line);
    expect(toText(briefing())).toContain(`\n${line}\n`);
    expect(toMarkdown(briefing())).toContain(`\n${line}\n`);
    const [m] = buildSlackMessages(briefing(), { postWhenEmpty: true });
    expect(JSON.stringify(m!.payload.blocks)).toContain(JSON.stringify(line));
  });

  it("varies the quiet-day line from day to day", () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    expect(new Set(days.map((date) => quietLine(briefing({ date })))).size).toBe(QUIET_LINES.length);
  });

  it("keeps the plain wording when personality is off", () => {
    const md = toMarkdown(briefing({ personality: false }));
    expect(md).toContain("No relevant updates today.");
    expect(md).toContain("Collected 120 items from 8 sources");
    expect(quietLine(briefing({ personality: false }))).toBeUndefined();
  });
});
