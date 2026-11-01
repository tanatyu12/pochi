import { readFile, rm } from "node:fs/promises";
import { ConfigError } from "../config/load.js";
import { isEnoent } from "../util/fs.js";

/**
 * A file the job needs could not be read or written: a ConfigError, so install, uninstall and
 * status end with 2 and init can warn and carry on, instead of an internal error. The message
 * names the path and the error code only.
 */
export function fsFailure(action: string, path: string, err: unknown): ConfigError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return new ConfigError(`could not ${action} ${path}${code ? ` (${code})` : ""}`, { cause: err });
}

export async function fsStep<T>(action: string, path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw fsFailure(action, path, err);
  }
}

/** undefined when the file does not exist; any other failure is an fsFailure. */
export async function unlessMissing<T>(action: string, path: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw fsFailure(action, path, err);
  }
}

/** The file's text, or undefined when it does not exist. */
export function readIfExists(path: string): Promise<string | undefined> {
  return unlessMissing("read", path, () => readFile(path, "utf8"));
}

/** Whether there was a file to remove. */
export async function removeIfExists(path: string): Promise<boolean> {
  return (await unlessMissing("remove", path, () => rm(path).then(() => true))) ?? false;
}
