import type { ExecFn, ExecResult } from "../../src/schedule/exec.js";

export interface ExecCall {
  command: string;
  args: readonly string[];
  input?: string;
}

/**
 * Records every call and answers from respond (exit 0 with no output by default). Pass a
 * function to keep state between calls, as a fake crontab does.
 */
export function fakeExec(respond: (call: ExecCall) => Partial<ExecResult> | undefined = () => undefined): {
  exec: ExecFn;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (command, args, opts = {}) => {
    const call = { command, args, input: opts.input };
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...respond(call) };
  };
  return { exec, calls };
}

/** A crontab held in memory, answering crontab -l and crontab -. */
export function fakeCrontab(initial?: string): { exec: ExecFn; calls: ExecCall[]; text: () => string | undefined } {
  let text = initial;
  const { exec, calls } = fakeExec((call) => {
    if (call.args[0] === "-l") {
      return text === undefined ? { code: 1, stderr: "crontab: no crontab for me\n" } : { stdout: text };
    }
    text = call.input ?? "";
    return undefined;
  });
  return { exec, calls, text: () => text };
}
