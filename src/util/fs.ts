/** Whether a failed fs call failed because the path does not exist. */
export function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
