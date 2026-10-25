export type Limit = <T>(fn: () => Promise<T>) => Promise<T>;

export function pLimit(concurrency: number): Limit {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer: ${concurrency}`);
  }
  const queue: (() => void)[] = [];
  let active = 0;

  const next = () => {
    if (active >= concurrency) return;
    const start = queue.shift();
    if (start) start();
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() => {
        active++;
        // then() turns a synchronous throw into a rejection.
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
