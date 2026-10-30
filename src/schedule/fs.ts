import { ConfigError } from "../config/load.js";

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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw fsFailure(action, path, err);
  }
}
