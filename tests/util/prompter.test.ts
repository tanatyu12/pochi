import { afterEach, describe, expect, it, vi } from "vitest";

const clack = vi.hoisted(() => {
  const CANCEL = Symbol("clack:cancel");
  return {
    CANCEL,
    isCancel: (v: unknown) => v === CANCEL,
    cancel: vi.fn(),
    text: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
  };
});
vi.mock("@clack/prompts", () => clack);

const { PromptCancelled, createClackPrompter } = await import("../../src/util/prompter.js");

afterEach(() => vi.clearAllMocks());

describe("createClackPrompter", () => {
  it("returns the answer", async () => {
    clack.text.mockResolvedValue("hello");
    clack.select.mockResolvedValue("b");
    clack.confirm.mockResolvedValue(false);
    const p = createClackPrompter();
    expect(await p.text({ message: "m" })).toBe("hello");
    expect(await p.select({ message: "m", options: [{ value: "b", label: "B" }] })).toBe("b");
    expect(await p.confirm({ message: "m" })).toBe(false);
    expect(clack.cancel).not.toHaveBeenCalled();
  });

  it.each(["text", "select", "confirm"] as const)("turns a cancelled %s into PromptCancelled", async (kind) => {
    clack[kind].mockResolvedValue(clack.CANCEL);
    const p = createClackPrompter();
    const call = kind === "select" ? p.select({ message: "m", options: [] }) : p[kind]({ message: "m" });
    await expect(call).rejects.toBeInstanceOf(PromptCancelled);
    expect(clack.cancel).toHaveBeenCalledOnce();
  });

  it("validates an untouched field as an empty string", async () => {
    clack.text.mockResolvedValue("x");
    const validate = vi.fn(() => undefined);
    await createClackPrompter().text({ message: "m", validate });
    const passed = clack.text.mock.calls[0]![0].validate as (v: string | undefined) => unknown;
    passed(undefined);
    expect(validate).toHaveBeenCalledWith("");
  });
});
