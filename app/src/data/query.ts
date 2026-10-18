/** A query keeps its last result while refreshing and coalesces changes during a request. */
export interface QueryState<T> { data?: T; error?: unknown; loading: boolean }
export function createQuery<T>(call: (op: string, params: unknown) => Promise<T>, publish: (state: QueryState<T>, key: string) => void) {
  type Entry = { op: string; params: unknown; revision: string; pending: boolean; dirty: boolean; state: QueryState<T> };
  const entries = new Map<string, Entry>();
  let current: Entry | undefined, disposed = false;
  const emit = (entry: Entry) => { if (!disposed && current === entry) publish({ ...entry.state }, JSON.stringify([entry.op, JSON.stringify(entry.params)])); };
  async function fetch(entry: Entry) {
    entry.pending = true;
    entry.dirty = false;
    entry.state = { ...entry.state, loading: true };
    emit(entry);
    try { entry.state = { data: await call(entry.op, entry.params), loading: false }; }
    catch (error) { entry.state = { ...entry.state, error, loading: false }; }
    entry.pending = false;
    emit(entry);
    // Publish the first result even when events arrived during the request.
    if (!disposed && current === entry && entry.dirty) void fetch(entry);
  }
  return {
    update(op: string, serialized: string, revision: string) {
      const key = JSON.stringify([op, serialized]);
      let entry = entries.get(key);
      const changedQuery = current !== entry;
      if (!entry) {
        entry = { op, params: JSON.parse(serialized), revision, pending: false, dirty: false, state: { loading: true } };
        entries.set(key, entry);
        current = entry;
        if (!disposed) void fetch(entry);
        return;
      }
      current = entry;
      if (entry.revision !== revision || changedQuery) {
        entry.revision = revision;
        if (entry.pending) entry.dirty = true;
        else if (!disposed) void fetch(entry);
      }
      emit(entry);
    },
    dispose() { disposed = true; },
  };
}
