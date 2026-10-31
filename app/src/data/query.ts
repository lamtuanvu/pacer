/** Queries retain visible data during refresh; caches belong to one API client. */
export interface QueryState<T> { data?: T; error?: unknown; loading: boolean }
type Publish<T> = (state: QueryState<T>, key: string) => void;
interface CacheOptions { now?: () => number; maxAgeMs?: number; maxEntries?: number }
export function createQueryCache<Result>(call: (op: string, params: unknown) => Promise<Result>, options: CacheOptions = {}) {
  type Entry = { key: string; op: string; params: unknown; revision: string; pending: boolean; dirty: boolean; checkedAt: number; state: QueryState<unknown>; listeners: Set<() => void> };
  const entries = new Map<string, Entry>();
  const now = options.now ?? (() => performance.now()), maxAgeMs = options.maxAgeMs ?? 2000, maxEntries = options.maxEntries ?? 128;
  const emit = (entry: Entry) => { for (const listener of entry.listeners) listener(); };
  // Active/pending entries must remain shared. Only unused completed entries are evicted.
  function prune() {
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries) break;
      if (!entry.pending && !entry.listeners.size) entries.delete(key);
    }
  }
  async function fetch(entry: Entry) {
    entry.pending = true;
    entry.dirty = false;
    entry.state = { ...entry.state, loading: true };
    emit(entry);
    try {
      entry.state = { data: await call(entry.op, entry.params), loading: false };
      entry.checkedAt = now();
    } catch (error) { entry.state = { ...entry.state, error, loading: false }; }
    entry.pending = false;
    emit(entry);
    // Publish the first response, then follow up once for changes received in flight.
    if (entry.listeners.size && entry.dirty) void fetch(entry);
    prune();
  }
  function refresh(entry: Entry) {
    if (entry.pending) entry.dirty = true;
    else void fetch(entry);
  }
  return {
    invalidate() { for (const entry of entries.values()) entry.dirty = true; },
    createQuery<T = Result>(publish: Publish<T>) {
      let current: Entry | undefined, disposed = false;
      const notify = () => { if (!disposed && current) publish({ ...current.state } as QueryState<T>, current.key); };
      return {
        update(op: string, serialized: string, revision: string) {
          if (disposed) return;
          const key = JSON.stringify([op, serialized]);
          let entry = entries.get(key);
          const changedQuery = current !== entry || !current;
          if (changedQuery) current?.listeners.delete(notify);
          if (!entry) {
            entry = { key, op, params: JSON.parse(serialized), revision, pending: false, dirty: false, checkedAt: -Infinity, state: { loading: true }, listeners: new Set() };
            entries.set(key, entry);
          }
          current = entry;
          entry.listeners.add(notify);
          // Move to the end for bounded least-recently-used history.
          entries.delete(key); entries.set(key, entry);
          const changedRevision = entry.revision !== revision;
          entry.revision = revision;
          if (changedRevision) refresh(entry);
          else if (!entry.pending && changedQuery && (entry.dirty || entry.state.error !== undefined || now() - entry.checkedAt >= maxAgeMs)) refresh(entry);
          notify();
          prune();
        },
        refresh() { if (!disposed && current) refresh(current); },
        setData(op: string, serialized: string, data: T) {
          const entry = entries.get(JSON.stringify([op, serialized]));
          if (!entry || disposed) return;
          entry.state = { ...entry.state, data, error: undefined };
          emit(entry);
        },
        dispose() { disposed = true; current?.listeners.delete(notify); current = undefined; prune(); },
      };
    },
  };
}
export function createQuery<T>(call: (op: string, params: unknown) => Promise<T>, publish: Publish<T>) {
  return createQueryCache(call).createQuery(publish);
}
// Weak ownership prevents sharing data between service connections or retaining retired clients.
const caches = new WeakMap<object, ReturnType<typeof createQueryCache>>();
export function queryCacheFor(client: object, call: (op: string, params: unknown) => Promise<unknown>) {
  let cache = caches.get(client);
  if (!cache) { cache = createQueryCache(call); caches.set(client, cache); }
  return cache;
}

/** A transport break may happen while no screen is mounted. Never reuse that data as fresh. */
export function invalidateQueryCache(client: object) { caches.get(client)?.invalidate(); }
