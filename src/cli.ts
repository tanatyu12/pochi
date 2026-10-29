import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { doctorCommand } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { scheduleCommand } from "./commands/schedule.js";
import { DEFAULT_CONFIG_DIR } from "./config/load.js";
import { ExitCode, PochiError, exitCodeOf } from "./errors.js";
import { redact } from "./util/log.js";
import { VERSION } from "./version.js";

export function createProgram(opts: { signal?: AbortSignal } = {}): Command {
  const program = new Command()
    .name("pochi")
    .description("Daily tech briefing for your project, delivered to Slack or Markdown files")
    .version(VERSION)
    // Before .command(): subcommands copy the parent's settings when they are created.
    .exitOverride();
  program
    .command("init")
    .description("Create config/context.yml and config/sources.yml interactively")
    .option("--config-dir <dir>", "directory to write the config to", DEFAULT_CONFIG_DIR)
    .option("--from <file>", "start from a proposal an agent wrote for your project (see --print-prompt)")
    .option("--print-prompt", "print the prompt that asks a coding agent for a proposal, and exit")
    // Optional and repeatable: who to follow, beyond what the project's own files show.
    .option("--competitor <name>", "a competitor to follow (repeatable)", collect)
    .option("--adopter <business>", "a business that may adopt or sell products like yours (repeatable)", collect)
    .option("--news-site <domain>", "a site that carries your industry's news, such as prtimes.jp (repeatable)", collect)
    .action(
      (o: {
        configDir: string;
        from?: string;
        printPrompt?: boolean;
        competitor?: string[];
        adopter?: string[];
        newsSite?: string[];
      }) =>
        runInit(
          {
            configDir: o.configDir,
            from: o.from,
            printPrompt: o.printPrompt,
            watch: { competitors: o.competitor, adopters: o.adopter, newsSites: o.newsSite },
          },
          { signal: opts.signal },
        ),
    );
  program
    .command("run")
    .description("Collect, filter and post today's briefing")
    .option("--dry-run", "print the briefing instead of posting it, and leave the state file as is")
    .option("--state <path>", "state file (default: $POCHI_STATE_PATH or state/notified.json)")
    .option("--no-state", "neither read nor write a state file")
    .option("--json", "print the result as JSON on stdout")
    .option("--config-dir <dir>", "directory with context.yml and sources.yml", DEFAULT_CONFIG_DIR)
    .option("--verbose", "log debug messages")
    .option("--quiet", "log only warnings and errors")
    .action((o) => runCommand(o, { signal: opts.signal }));
  // addCommand does not copy the parent's settings, so this one needs its own exitOverride.
  program.addCommand(doctorCommand({ signal: opts.signal }).exitOverride());
  program.addCommand(scheduleCommand());
  return program;
}

// Without a default, so --help does not show an empty list for options left out.
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  // The first Ctrl-C lets the run record what it already paid for; a second one does not wait.
  // SIGTERM only asks: cancelling an Actions run sends it after SIGINT, and SIGKILL follows anyway.
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(ExitCode.INTERRUPTED);
    controller.abort();
  };
  const onSigterm = () => controller.abort();
  process.on("SIGINT", onSigint).on("SIGTERM", onSigterm);
  const program = createProgram({ signal: controller.signal });
  try {
    await program.parseAsync(argv);
    return ExitCode.OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version land here with 0; commander's own usage errors use 1.
      // Any other code was chosen explicitly (program.error(..., { exitCode })) and is kept.
      if (err.exitCode === 0) return ExitCode.OK;
      return err.exitCode === 1 ? ExitCode.CONFIG : err.exitCode;
    }
    process.stderr.write(redact(formatError(err)));
    return exitCodeOf(err);
  } finally {
    process.off("SIGINT", onSigint).off("SIGTERM", onSigterm);
  }
}

// Expected failures print their message (and cause); anything else is a bug, so print the stack.
function formatError(err: unknown): string {
  if (!(err instanceof PochiError)) {
    return `pochi: internal error\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
  }
  const cause = err.cause instanceof Error ? err.cause.message : err.cause;
  return `pochi: ${err.message}\n${cause === undefined ? "" : `  cause: ${String(cause)}\n`}`;
}

// import.meta.main is missing before Node 22.18, so compare paths instead.
function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await main();
}
