import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { StoreState } from "../store";
import { ApiError, type BrowserApi } from "../api";
import { Button } from "../ds/Button";
import { Pill } from "../ds/Pill";
import { executorName, taskHref, taskStatus, type TaskSummary } from "../model/tasks";
export const TaskContext = createContext<{ state: StoreState; api: BrowserApi }>(null!);
export const useTaskContext = () => useContext(TaskContext);
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="op-error" role="status"><p>{error instanceof Error ? error.message : String(error)}</p>{error instanceof ApiError && error.hint && <p>{error.hint}</p>}</div>;
}
export function useQuery<T>(op: string, params: unknown, revision = "") {
  const { api, state } = useTaskContext();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [version, reload] = useState(0);
  const serialized = JSON.stringify(params);
  const invalidation = JSON.stringify(state.invalidations);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.call<T>(op, JSON.parse(serialized)).then(result => { if (active) { setData(result); setError(undefined); } }, error => { if (active) setError(error); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, op, serialized, revision, invalidation, state.connected, version]);
  return { data, error, loading, reload: () => reload(v => v + 1) };
}
export function useAction() {
  const { api } = useTaskContext();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [message, setMessage] = useState("");
  const pending = useRef(false);
  async function run<T>(op: string, params: unknown, done?: (result: T) => void) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); setMessage("");
    try { const result = await api.call<T>(op, params); done?.(result); setMessage("Recorded."); }
    catch (error) { setError(error); }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, error, message, run };
}
export function useDraft<T extends { [K in keyof T]: string }>(key: string, defaults: T) {
  const [draft, setDraft] = useState<T>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
      return { ...defaults, ...Object.fromEntries(Object.keys(defaults).filter(k => typeof saved?.[k] === "string").map(k => [k, saved[k]])) };
    } catch { return defaults; }
  });
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* storage unavailable */ } }, [key, draft]);
  return [draft, setDraft] as const;
}
export function Dialog({ title, close, children }: { title: string; close: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => { dialog.close(); }; }, []);
  return <dialog ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}><div className="dialog-head"><h1>{title}</h1><Button onClick={close}>Close</Button></div>{children}</dialog>;
}
export function TaskLink({ id, children }: { id: string; children: ComponentChildren }) { return <a href={taskHref(id)}>{children}</a>; }
export function TaskRow({ task, reload, onDismiss }: { task: ReturnType<typeof import("../model/tasks").tasksModel>[number]; reload: () => void; onDismiss: (ids: string[]) => void }) {
  const action = useAction();
  return <div className="task-row"><Pill tone={task.status.tone}>{task.status.label}</Pill><div className="grow"><TaskLink id={task.id}>{task.goal}</TaskLink><div className="muted">{task.executor}{task.kind && ` · ${task.kind}`}{task.placement?.mode && ` · ${task.placement.mode} worktree`}</div></div><div className="row-actions">{task.actions.map(op => <Button key={op} size="sm" disabled={action.busy} onClick={() => { void action.run<{ retry?: TaskSummary; dismissed?: string[]; unknown?: string[] }>(`task.${op}`, op === "dismiss" ? { ids: [task.id] } : { id: task.id }, result => { if (result.dismissed) onDismiss(result.dismissed); reload(); if (result.unknown?.length) throw new Error(`Unknown task: ${result.unknown.join(", ")}`); if (result.retry) location.hash = taskHref(result.retry.task_id); }); }}>{op === "stop" ? "Stop" : op === "retry" ? "Retry" : "Dismiss"}</Button>)}</div><div className="row-result" aria-live="polite"><ErrorMessage error={action.error} />{action.message}</div></div>;
}
export function SnapshotRow({ task }: { task: import("../../../src/link/envelope").TaskData }) {
  const status = taskStatus(task);
  return <div className="task-row"><Pill tone={status.tone}>{status.label}</Pill><div className="grow"><TaskLink id={task.id}>{task.goal}</TaskLink><div className="muted">{executorName(task.executor)}{task.progress && ` · ${task.progress.files} files · ${task.progress.commits} commits`}</div></div><TaskLink id={task.id}>Open</TaskLink></div>;
}
