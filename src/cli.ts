import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { ExitCode, PochiError, exitCodeOf } from "./errors.js";
import { VERSION } from "./version.js";

export function createProgram(): Command {
  return new Command()
    .name("pochi")
    .description("Daily tech briefing for your project, delivered to Slack")
    .version(VERSION);
}

export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const program = createProgram().exitOverride();
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
    process.stderr.write(formatError(err));
    return exitCodeOf(err);
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
