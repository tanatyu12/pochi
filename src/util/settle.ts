/**
 * Like Promise.allSettled for one promise. Settled at once, a promise awaited only later is
 * never an unhandled rejection while other work runs.
 */
export function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}
