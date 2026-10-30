/** A service-owned stale-while-revalidate value. Rebuilds start on a later turn,
 * so even the synchronous prefix of a builder cannot delay a warm read. */
export function createReadCache<T>(build: () => Promise<T>, maxAgeMs: number) {
  let value: T | undefined;
  let hasValue = false;
  let builtAt = -Infinity;
  let pending: Promise<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const refresh = (): Promise<T> => {
    if (pending) return pending;
    pending = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        timer = undefined;
        Promise.resolve().then(build).then(next => {
          if (!stopped) { value = next; hasValue = true; builtAt = Date.now(); }
          pending = undefined;
          resolve(next);
        }, error => { pending = undefined; reject(error); });
      }, 0);
    });
    return pending;
  };
  return {
    get(): Promise<T> {
      if (!hasValue) return refresh();
      if (!stopped && Date.now() - builtAt >= maxAgeMs) void refresh().catch(() => {});
      // A refresh error never discards a successful value. Cold failures still reject.
      return Promise.resolve(value!);
    },
    refresh,
    async refreshAfterPending() {
      if (pending) await pending.catch(() => {});
      return refresh();
    },
    stop() { stopped = true; clearTimeout(timer); },
  };
}
