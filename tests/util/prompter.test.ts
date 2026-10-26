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
    multiselect: vi.fn(),
    spinner: vi.fn(),
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
    clack.multiselect.mockResolvedValue([]);
    const p = createClackPrompter();
    expect(await p.text({ message: "m" })).toBe("hello");
    expect(await p.select({ message: "m", options: [{ value: "b", label: "B" }] })).toBe("b");
    expect(await p.confirm({ message: "m" })).toBe(false);
    expect(await p.multiselect({ message: "m", options: [{ value: "a", label: "A" }] })).toEqual([]);
    // Choosing nothing is an answer.
    expect(clack.multiselect.mock.calls[0]![0]).toMatchObject({ required: false });
    expect(clack.cancel).not.toHaveBeenCalled();
  });

  it.each(["text", "select", "multiselect", "confirm"] as const)("turns a cancelled %s into PromptCancelled", async (kind) => {
    clack[kind].mockResolvedValue(clack.CANCEL);
    const p = createClackPrompter();
    const call =
      kind === "select" || kind === "multiselect" ? p[kind]({ message: "m", options: [] }) : p[kind]({ message: "m" });
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

  it("spins while the task runs and passes its result or error on", async () => {
    const s = { start: vi.fn(), stop: vi.fn(), error: vi.fn() };
    clack.spinner.mockReturnValue(s);
    const signal = new AbortController().signal;
    const p = createClackPrompter();
    expect(await p.spin("Fetching", async () => 42, signal)).toBe(42);
    expect(clack.spinner).toHaveBeenCalledWith({ signal });
    expect(s.start).toHaveBeenCalledWith("Fetching");
    expect(s.stop).toHaveBeenCalledWith("Fetching");

    const boom = new Error("boom");
    await expect(p.spin("Fetching", async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(s.error).toHaveBeenCalledWith("Fetching");
  });
});
