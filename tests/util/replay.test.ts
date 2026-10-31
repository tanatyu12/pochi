import { describe, expect, it } from "vitest";
import { PromptBack } from "../../src/util/prompter.js";
import { replayingPrompter } from "../../src/util/replay.js";
import { BACK, scriptedPrompter } from "../helpers/scriptedPrompter.js";

/** Runs flow the way runInit does: again from the start after each PromptBack. */
async function run<T>(flow: (p: ReturnType<typeof replayingPrompter>) => Promise<T>, p: ReturnType<typeof replayingPrompter>) {
  for (;;) {
    try {
      return await flow(p);
    } catch (err) {
      if (!(err instanceof PromptBack)) throw err;
      p.back();
    }
  }
}

const flow = async (p: ReturnType<typeof replayingPrompter>) => {
  p.intro("title");
  p.note("start");
  const name = await p.text({ message: "Name" });
  const color = await p.select({ message: "Color", options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] });
  const tags = await p.multiselect({ message: "Tags", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
  const ok = await p.confirm({ message: "OK?" });
  return { name, color, tags, ok };
};

describe("replayingPrompter", () => {
  it("goes back one question at a time, offering the answer given before", async () => {
    const inner = scriptedPrompter(["app", "red", BACK, "blue", ["a"], BACK, BACK, BACK, "pochi", "blue", ["b"], true]);
    const result = await run(flow, replayingPrompter(inner));
    expect(result).toEqual({ name: "pochi", color: "blue", tags: ["b"], ok: true });
    // Each question once more per step back, with what was answered before as the default.
    expect(inner.asked).toEqual(["Name", "Color", "Tags", "Color", "Tags", "OK?", "Tags", "Color", "Name", "Color", "Tags", "OK?"]);
    expect(inner.initial).toMatchObject({ Name: "app", Color: "blue", Tags: ["a"] });
    // A replay shows nothing again; the note is shown on the runs that start at the first question.
    expect(inner.shown.filter((s) => s === "note: start")).toHaveLength(2);
    expect(inner.shown.filter((s) => s === "intro: title")).toHaveLength(1);
  });

  it("asks the first question again when going back from it", async () => {
    const inner = scriptedPrompter([BACK, "app", "red", [], false]);
    expect(await run(flow, replayingPrompter(inner))).toEqual({ name: "app", color: "red", tags: [], ok: false });
    expect(inner.asked.slice(0, 2)).toEqual(["Name", "Name"]);
  });

  it("asks the same question again once frozen", async () => {
    const inner = scriptedPrompter([BACK, true]);
    const p = replayingPrompter(inner);
    p.freeze?.();
    expect(await p.confirm({ message: "Install?" })).toBe(true);
    expect(inner.asked).toEqual(["Install?", "Install?"]);
  });

  it("asks from where a replay takes another path", async () => {
    let second = false;
    const branching = async (p: ReturnType<typeof replayingPrompter>) => {
      const a = await p.text({ message: "A" });
      // The first run asks B; later runs ask C instead, as a fetch that changed would.
      const b = second ? await p.text({ message: "C" }) : await p.text({ message: "B" });
      second = true;
      return [a, b, await p.text({ message: "D" })];
    };
    const inner = scriptedPrompter(["a", "b", BACK, "c", "d"]);
    expect(await run(branching, replayingPrompter(inner))).toEqual(["a", "c", "d"]);
  });
});
