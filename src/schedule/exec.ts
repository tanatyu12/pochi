import { spawn as nodeSpawn } from "node:child_process";
import { ConfigError } from "../config/load.js";
import type { SpawnFn } from "../llm/cli.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion. A non-zero exit is a result, not an error; a missing command throws. */
export type ExecFn = (command: string, args: readonly string[], opts?: { input?: string }) => Promise<ExecResult>;

/** An ExecFn on top of spawn, which tests replace. */
export function createExec(spawn: SpawnFn = nodeSpawn): ExecFn {
  return (command, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", (e: NodeJS.ErrnoException) => {
        reject(e.code === "ENOENT" ? new ConfigError(`${command} was not found on PATH`) : e);
      });
      child.on("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
      // A command that does not read stdin may close it first; that is not a failure.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    });
}

export const exec: ExecFn = createExec();
