import { TextAction } from "../ds/Button";
import { useActions } from "../data/action-context";
import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { StoreState } from "../data/store";
import { ApiError, type BrowserApi } from "../data/api";
import { createQuery, type QueryState } from "../data/query";
import { draftStorage } from "../model/draft";
import { taskHref } from "../model/tasks";
export const TaskContext = createContext<{ state: StoreState; api: BrowserApi }>(null!);
export const useTaskContext = () => useContext(TaskContext);
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="op-error" role="status"><p>{error instanceof Error ? error.message : String(error)}</p>{error instanceof ApiError && error.hint && <p>{error.hint}</p>}</div>;
}
/** Task reads follow only this task, rather than unrelated snapshot traffic. */
export function queryRevision(state: StoreState, op: string, params: unknown): string {
  if (op === "task.list") return JSON.stringify([state.invalidations, state.snapshot?.tasks.map(t=>[t.id,t.rev,t.state,t.updatedAt])]);
  if (["task.get", "task.diff", "task.session"].includes(op)) {
    const id = (params as { id?: string } | null)?.id;
    const task = state.snapshot?.tasks.find(task => task.id === id);
    return JSON.stringify([...(op === "task.get" ? [state.invalidations["project-strategies"]] : []), task?.rev, task?.updatedAt, state.activity.filter(entry => entry.taskId === id)]);
  }
  return JSON.stringify(state.invalidations);
}
export function useQuery<T>(op: string, params: unknown, revision = "") {
  const { api, state } = useTaskContext();
  const [published, setResult] = useState<{ key: string; state: QueryState<T> }>();
  const [version, reload] = useState(0);
  const serialized = JSON.stringify(params);
  const invalidation = queryRevision(state, op, params);
  const query = useMemo(() => createQuery<T>((op, params) => api.call<T>(op, params), (state, key) => setResult({ state, key })), [api]);
  useEffect(() => () => query.dispose(), [query]);
  useEffect(() => {
    query.update(op, serialized, JSON.stringify([revision, invalidation, state.connected, version]));
  }, [query, op, serialized, revision, invalidation, state.connected, version]);
  const result = published?.key === JSON.stringify([op, serialized]) ? published.state : { loading: true };
  return { ...result, updating: result.loading && result.data !== undefined, setData: (data: T) => query.setData(op, serialized, data), reload: () => reload(v => v + 1) };
}
export function useAction() {
  const runner = useActions();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [message, setMessage] = useState("");
  const pending = useRef(false);
  async function run<T>(op: string, params: unknown, done?: (result: T) => void) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); setMessage("");
    try {
      const key = `operation:${op}:${JSON.stringify(params)}`;
      const outcome = await runner.run(key, {label: op, op, params: params as Record<string, unknown>});
      if (outcome.status === "error") { setError(new Error(outcome.message + (outcome.hint ? ` · ${outcome.hint}` : ""))); return; }
      if (outcome.status === "handled") { setMessage(outcome.message); return; }
      done?.(runner.result(key) as T); setMessage("Recorded.");
    }
    catch (error) { setError(error); }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, error, message, run };
}
export function useDraft<T extends { [K in keyof T]: string }>(key: string, defaults: T, initialize: (saved: T) => T = saved => saved) {
  // Resolve sessionStorage lazily too: browsers may deny access to the property.
  const storage = draftStorage(key, defaults, {
    getItem: name => sessionStorage.getItem(name),
    setItem: (name, value) => sessionStorage.setItem(name, value),
    removeItem: name => sessionStorage.removeItem(name),
  });
  const [draft, update] = useState<T>(() => initialize(storage.read()));
  const current = useRef(draft);
  const setDraft = (value: T | ((previous: T) => T)) => {
    const next = typeof value === "function" ? value(current.current) : value;
    current.current = next;
    storage.write(next);
    update(next);
  };
  const clearDraft = () => { current.current = defaults; storage.clear(); update(defaults); };
  return [draft, setDraft, clearDraft] as const;
}
export { Dialog } from "../ds/Dialog";
export function TaskLink({ id, children }: { id: string; children: ComponentChildren }) { return <TextAction className="pc-text-action" href={taskHref(id)}>{children}</TextAction>; }
