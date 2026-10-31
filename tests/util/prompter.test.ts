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
    unicode: true,
    log: { warn: vi.fn(), step: vi.fn(), error: vi.fn() },
  };
});
vi.mock("@clack/prompts", () => clack);

const { PromptCancelled, createClackPrompter } = await import("../../src/util/prompter.js");
const { log, resetLog } = await import("../../src/util/log.js");

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetLog();
});

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

  it("lets a full-width space toggle in a multiselect, as Space types it with a Japanese IME on", async () => {
    const before = process.stdin.listenerCount("keypress");
    clack.multiselect.mockImplementation(async () => {
      const names: (string | undefined)[] = [];
      const record = (_: string, key: { name?: string } | undefined) => void names.push(key?.name);
      process.stdin.on("keypress", record);
      // Typed once the prompt is up, as a real key is.
      await new Promise((resolve) => setImmediate(resolve));
      process.stdin.emit("keypress", "\u3000", { sequence: "\u3000" });
      process.stdin.off("keypress", record);
      return names;
    });
    // The mock answers with the key names it saw.
    expect(await createClackPrompter().multiselect({ message: "m", options: [] })).toEqual([undefined, "space"]);
    expect(process.stdin.listenerCount("keypress")).toBe(before);
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
    const p = createClackPrompter();
    expect(await p.spin("Fetching", async () => 42)).toBe(42);
    expect(clack.log.step).toHaveBeenCalledWith("Fetching");

    const boom = new Error("boom");
    await expect(p.spin("Fetching", async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(clack.log.error).toHaveBeenCalledWith("Fetching");

    const controller = new AbortController();
    controller.abort();
    await expect(p.spin("Fetching", async () => Promise.reject(boom), controller.signal)).rejects.toBe(boom);
    expect(clack.log.error).toHaveBeenLastCalledWith("Fetching: cancelled");
  });

  it("turns Ctrl-C while spinning into SIGINT in the process, not an OS signal", async () => {
    // Stands in for main's handler, which would abort the run.
    const emit = vi.spyOn(process, "emit").mockImplementation((() => true) as never);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const before = process.stdin.listenerCount("keypress");

    let release!: () => void;
    const spinning = createClackPrompter().spin("Fetching", () => new Promise<void>((r) => (release = r)));
    process.stdin.emit("keypress", "x", { name: "x" });
    expect(emit).not.toHaveBeenCalledWith("SIGINT");
    process.stdin.emit("keypress", "\x03", { name: "c", ctrl: true });
    expect(emit).toHaveBeenCalledExactlyOnceWith("SIGINT");
    expect(kill).not.toHaveBeenCalled();

    release();
    await spinning;
    expect(process.stdin.listenerCount("keypress")).toBe(before);
  });

  it("holds log lines written while spinning until the spinner has stopped", async () => {
    const order: string[] = [];
    clack.log.step.mockImplementation(() => order.push("stop"));
    clack.log.error.mockImplementation(() => order.push("error"));
    clack.log.warn.mockImplementation((m: string) => order.push(`warn: ${m}`));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const p = createClackPrompter();

    await p.spin("Fetching", async () => log.warn("could not check an advertised feed"));
    await expect(
      p.spin("Fetching", async () => {
        log.warn("second");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(order).toEqual(["stop", "warn: could not check an advertised feed", "error", "warn: second"]);
    expect(stderr).not.toHaveBeenCalled();
    // Back to stderr once the spinner is gone.
    log.warn("after");
    expect(stderr).toHaveBeenCalledOnce();
  });
});
