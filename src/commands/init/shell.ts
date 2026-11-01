import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

/** Quotes a value for a POSIX shell, leaving plain paths as they are. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

// One git call for paths that share a directory. It runs in that directory so a --config-dir
// inside another repository is checked against that one.
export async function gitCheckIgnored(paths: string[]): Promise<(boolean | undefined)[]> {
  const [first] = paths;
  if (first === undefined) return [];
  const names = paths.map((path) => basename(path));
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("git", ["check-ignore", "--", ...names], {
      cwd: dirname(resolve(first)),
    }));
  } catch (err) {
    // 1 means none is ignored; anything else (128 outside a repository, ENOENT without git) means unknown.
    const { code, stdout: out } = err as { code?: unknown; stdout?: unknown };
    if (code !== 1) return paths.map(() => undefined);
    stdout = typeof out === "string" ? out : "";
  }
  // Prints the ignored ones among the names it was given, one per line as given
  // (the names are context.yml and sources.yml, so git has nothing to quote).
  const ignored = new Set(stdout.split("\n"));
  return names.map((name) => ignored.has(name));
}
