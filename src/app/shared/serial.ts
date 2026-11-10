/**
 * Runs asynchronous jobs one after the other, in the order they were given. For changes that build on the
 * state the one before left (a list that is read, changed and stored): two started at once would both start
 * from the same old state and the first change would be lost. A failed job does not stop the ones after it.
 */
export function serial(): <T>(job: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = last.then(job, job);
    last = next.catch(() => undefined);
    return next;
  };
}
