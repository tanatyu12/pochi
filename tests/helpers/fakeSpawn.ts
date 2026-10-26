import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { SpawnFn } from "../../src/llm/cli.js";

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  /** Everything written to stdin so far. */
  readonly stdin: string;
  /** Signals passed to kill(), in order. */
  signals: NodeJS.Signals[];
}

/** Drives one fake child process: what it prints, when it exits, how it reacts to kill(). */
export type Script = (child: FakeChild) => void;

export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  /** Set by a script to override the default reaction to kill(), which is to exit. */
  onKill?: (signal: NodeJS.Signals) => void;
  private readonly input: Buffer[] = [];
  private exited = false;

  constructor(readonly call: SpawnCall) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.input.push(chunk);
        callback();
      },
    });
  }

  get stdinText(): string {
    return Buffer.concat(this.input).toString("utf8");
  }

  /** Resolves when the caller has ended stdin. */
  stdinEnded(): Promise<void> {
    return finished(this.stdin);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.call.signals.push(signal);
    if (this.onKill) this.onKill(signal);
    else this.exit(null, signal);
    return true;
  }

  /**
   * Ends the output streams, then emits close the way node does once stdio has drained. With
   * keepPipesOpen, only exit is emitted, as when a process the child started still holds stdio.
   */
  exit(code: number | null, signal: NodeJS.Signals | null = null, opts: { keepPipesOpen?: boolean } = {}): void {
    if (this.exited) return;
    this.exited = true;
    if (opts.keepPipesOpen) {
      process.nextTick(() => this.emit("exit", code, signal));
      return;
    }
    this.stdout.end();
    this.stderr.end();
    void Promise.all([finished(this.stdout), finished(this.stderr)]).then(() => {
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    });
  }
}

export const run = {
  /** Reads all of stdin, prints stdout (and stderr), then exits with code. */
  exit:
    (stdout: string, opts: { code?: number; stderr?: string; keepPipesOpen?: boolean } = {}): Script =>
    (child) => {
      void child.stdinEnded().then(() => {
        child.stdout.write(stdout);
        if (opts.stderr) child.stderr.write(opts.stderr);
        child.exit(opts.code ?? 0, null, { keepPipesOpen: opts.keepPipesOpen });
      });
    },
  /** run.exit with the contents of tests/fixtures/claude/<name>. */
  fixture: (name: string, opts: { code?: number; stderr?: string } = {}): Script =>
    run.exit(readFileSync(new URL(`../fixtures/claude/${name}`, import.meta.url), "utf8"), opts),
  /** Prints the chunks one write at a time, then exits with 0 unless killed first. */
  chunks:
    (chunks: (string | Buffer)[]): Script =>
    (child) => {
      void child.stdinEnded().then(() => {
        for (const chunk of chunks) child.stdout.write(chunk);
        child.exit(0);
      });
    },
  /** Never exits on its own. With ignoreSigint, only SIGKILL ends it. */
  hang:
    (opts: { ignoreSigint?: boolean; keepPipesOpen?: boolean } = {}): Script =>
    (child) => {
      child.onKill = (signal) => {
        if (signal === "SIGKILL" || !opts.ignoreSigint) {
          child.exit(null, signal, { keepPipesOpen: opts.keepPipesOpen });
        }
      };
    },
  /** The command could not be started: error, then close, as node reports ENOENT. */
  spawnError:
    (code = "ENOENT"): Script =>
    (child) => {
      process.nextTick(() => {
        const err = Object.assign(new Error(`spawn ${child.call.command} ${code}`), { code, syscall: "spawn" });
        child.emit("error", err);
        child.exit(-2);
      });
    },
};

export interface SpawnMock {
  spawn: SpawnFn;
  calls: SpawnCall[];
  /** Resolves once spawn has been called n times. Uses no timers, so it works under fake ones. */
  spawned(n?: number): Promise<void>;
}

/**
 * A spawn that runs scripts instead of commands. One script is reused for every call; a list is
 * consumed in order, and spawning past its end throws so that unexpected calls fail loudly.
 */
export function fakeSpawn(scripts: Script | Script[]): SpawnMock {
  const queue = Array.isArray(scripts) ? [...scripts] : undefined;
  const calls: SpawnCall[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const script = queue ? queue.shift() : (scripts as Script);
    if (script === undefined) throw new Error(`fakeSpawn: no scripts left for ${command}`);
    const call: SpawnCall = {
      command,
      args: [...args],
      options,
      get stdin() {
        return child.stdinText;
      },
      signals: [],
    };
    const child: FakeChild = new FakeChild(call);
    calls.push(call);
    script(child);
    for (const w of waiters.filter((w) => calls.length >= w.n)) w.resolve();
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const spawned = (n = 1) =>
    calls.length >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve }));
  return { spawn, calls, spawned };
}
