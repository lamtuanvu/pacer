import { useActions } from "../data/action-context";
import { AgentMark } from "../ds/AgentMark";
import { markAgent } from "../../../src/view-model/agents";
import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { StoreState } from "../data/store";
import { ApiError, type BrowserApi } from "../data/api";
import { draftStorage } from "../model/draft";
import { Button } from "../ds/Button";
import { Pill } from "../ds/Pill";
import { taskHref } from "../model/tasks";
import { executorLabel, taskStatus } from "../../../src/view-model/words";
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
  return { data, setData, error, loading, reload: () => reload(v => v + 1) };
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
export function useDraft<T extends { [K in keyof T]: string }>(key: string, defaults: T) {
  // Resolve sessionStorage lazily too: browsers may deny access to the property.
  const storage = draftStorage(key, defaults, {
    getItem: name => sessionStorage.getItem(name),
    setItem: (name, value) => sessionStorage.setItem(name, value),
    removeItem: name => sessionStorage.removeItem(name),
  });
  const [draft, update] = useState<T>(() => storage.read());
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
export function Dialog({ title, close, children }: { title: string; close: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => { dialog.close(); }; }, []);
  return <dialog ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}><div className="dialog-head"><h1>{title}</h1><Button onClick={close}>Close</Button></div>{children}</dialog>;
}
export function TaskLink({ id, children }: { id: string; children: ComponentChildren }) { return <a href={taskHref(id)}>{children}</a>; }
export function SnapshotRow({ task }: { task: import("../../../src/link/envelope").TaskData }) {
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  const status = taskStatus(task);
  return <div className="task-row"><Pill tone={status.tone}>{status.label}</Pill><div className="grow"><TaskLink id={task.id}>{task.goal}</TaskLink><div className="muted">{task.executor && <AgentMark agent={markAgent(task.executor)} size={16} labelled={false} />} {executorLabel(task.executor, accounts.data ?? [])}{task.progress && ` · ${task.progress.files} files · ${task.progress.commits} commits`}</div></div><TaskLink id={task.id}>Open</TaskLink></div>;
}
