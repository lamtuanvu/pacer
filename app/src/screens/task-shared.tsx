import { budgetResourceRevision } from "../data/budget-revision";
import { Alert } from "../ds/Alert";
import { TextAction } from "../ds/Button";
import { useActions } from "../data/action-context";
import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { StoreState } from "../data/store";
import { ApiError, readOperation, type BrowserApi } from "../data/api";
import { queryCacheFor, type QueryState } from "../data/query";
import { workspaceManager } from "../workspace/manager";
import { useViewActive, useWorkspaceKey, useWorkspaceState } from "../workspace/state";
import { taskHref } from "../model/tasks";
export const TaskContext = createContext<{ state: StoreState; api: BrowserApi }>(null!);
const guardedApis = new WeakMap<BrowserApi, WeakMap<object, BrowserApi>>();
export function useTaskContext() {
 const context = useContext(TaskContext), runner = useActions();
 const api = context?.api;
 let guarded: BrowserApi | undefined = api;
 if (api && runner?.call) {
  const byRunner = guardedApis.get(api) ?? new WeakMap<object, BrowserApi>(); guardedApis.set(api, byRunner);
  guarded = byRunner.get(runner);
  if (!guarded) { guarded = { ...api, call: <T,>(op: string, params: unknown = {}) => readOperation(op) ? api.call<T>(op, params) : runner.call<T>(op, params) }; byRunner.set(runner, guarded); }
 }
 return context && guarded ? { ...context, api: guarded } : context;
}
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert tone="error" title="Something went wrong"><p>{error instanceof Error ? error.message : String(error)}</p>{error instanceof ApiError && error.hint && <p>{error.hint}</p>}</Alert>;
}
/** Task reads follow only this task, rather than unrelated snapshot traffic. */
const CONFIG_AREAS = ['accounts', 'config', 'delegation', 'hosts', 'machine', 'mode', 'plugins', 'project-strategies', 'routing', 'runners', 'setup', 'strategy', 'update', 'discovery', 'project-messaging', 'diagnostics'];
export function queryRevision(state: StoreState, op: string, params: unknown): string {
  if(op.startsWith("session.agent."))return JSON.stringify([state.invalidations,state.snapshot?.machine?.agentSessionsRevision]);
  const budget = budgetResourceRevision(op, state.invalidations, state.snapshot?.accounts);
  if (budget !== undefined && op !== "account.list") return budget;
  if (op === "msg.log") {
    const task = (params as { task?: string } | null)?.task;
    return JSON.stringify([state.invalidations[`msg:${task}`] ?? 0]);
  }
  if (op === "task.list") return JSON.stringify([state.invalidations["project-strategies"], state.snapshot?.tasks.map(t=>[t.id,t.rev,t.state,t.updatedAt])]);
  // Work rows carry the token roll-up; an attempt's tokens are recorded before its task changes state, so a
  // state change (or a new node) is when they move. Progress revisions alone would refetch every row each tick.
  if (op === "dispatch.list") return JSON.stringify([state.invalidations["project-strategies"], state.snapshot?.tasks.map(t=>[t.id,t.state])]);
  if (op === "dispatch.tree") return JSON.stringify([state.invalidations["project-strategies"], state.snapshot?.tasks.map(task => [task.id, task.rev, task.state, task.updatedAt])]);
  if (["task.get", "task.diff", "task.session"].includes(op)) {
    const id = (params as { id?: string } | null)?.id;
    const task = state.snapshot?.tasks.find(task => task.id === id);
    return JSON.stringify([...(op === "task.get" ? [state.invalidations["project-strategies"]] : []), ...(op === "task.session" ? [task?.rev, task?.state, task?.executor, task?.backend] : [task?.rev, task?.state, task?.updatedAt]), task?.messages, ...(op !== "task.get" ? [state.activity.find(entry => entry.taskId === id)?.id] : []), ...(op === "task.get" ? [state.invalidations[`msg:${id}`] ?? 0] : [])]);
  }
  const areas: Record<string, string[]> = {
    account: ['accounts'], config: CONFIG_AREAS, notifications: ['config'],
    runner: ['runners'], agent: ['accounts', 'runners', 'setup'], msg: ['project-messaging'],
    routing: ['accounts', 'runners', 'routing', 'strategy', 'hosts', 'mode', 'config', 'project-strategies'],
    dispatch: ['project-strategies', 'strategy', 'routing', 'runners', 'config'],
    session: ['accounts', 'runners', 'hosts'], plugin: ['plugins'],
    setup: ['setup', 'accounts', 'runners', 'diagnostics'],
  };
  const revisions = (areas[op.split('.')[0]!] ?? CONFIG_AREAS).map(area => [area, state.invalidations[area] ?? 0]);
  if (op === "account.list") return JSON.stringify([revisions, state.snapshot?.accounts?.map(account => [account.name, account.capturedAt, account.usedPct, account.resetsAt, account.stale, account.signedIn])]);
  return JSON.stringify(op.startsWith('plugin.') ? [...revisions, ['plugin', state.invalidations.plugin ?? 0]] : revisions);
}
/** task.session is refetched only when the task record changes. A read that landed before the session host was
 * up reports it not live, and a provider-owned run may not change its record again; a pane's live connection is
 * the signal to read it again. Stable while live is unchanged, so a terminal effect cannot loop on it. */
export function useSessionLiveReread(session: { data?: { live?: boolean }; reload: () => void }): () => void {
  const live = session.data?.live === true, reload = useRef(session.reload);
  reload.current = session.reload;
  return useCallback(() => { if (!live) reload.current(); }, [live]);
}

export function useQuery<T>(op: string, params: unknown, revision = "", keepPreviousData = op === "task.get", enabled = true) {
  const { api, state } = useContext(TaskContext);
  const viewActive = useViewActive();
  enabled = enabled && viewActive;
  const [published, setResult] = useState<{ api: BrowserApi; key: string; state: QueryState<T> }>();
  const serialized = JSON.stringify(params);
  const invalidation = queryRevision(state, op, params);
  const cache = queryCacheFor(api, (op, params) => api.call(op, params));
  const query = useMemo(() => cache.createQuery<T>((state, key) => setResult({ api, state, key }), keepPreviousData), [api, keepPreviousData, viewActive]);
  useEffect(() => () => query.dispose(), [query]);
  const last = useRef<{ query: typeof query; key: string; connected: boolean; connectionRevision: number }>();
  useEffect(() => {
    if (!enabled || state.sessionEnded) return;
    const key = JSON.stringify([op, serialized, revision]);
    const immediate = !last.current || last.current.query !== query || last.current.key !== key
      || last.current.connectionRevision !== state.connectionRevision;
    const update = () => {
      const mounted = !last.current || last.current.query !== query;
      last.current = { query, key, connected: state.connected, connectionRevision: state.connectionRevision };
      query.update(op, serialized, JSON.stringify([revision, invalidation, state.connectionRevision]), mounted);
    };
    // Initial selection and reconnects are immediate. Event bursts settle once.
    if (immediate) { update(); return; }
    const timer = setTimeout(update, 150);
    return () => clearTimeout(timer);
  }, [query, op, serialized, revision, invalidation, state.connected, state.connectionRevision, state.sessionEnded, enabled]);
  const sameClient = published?.api === api;
  const cached = enabled ? cache.peek<T>(op, serialized) : undefined;
  const result = sameClient && published.key === JSON.stringify([op, serialized]) ? published.state : {
    ...cached, loading: true,
    ...(cached?.data === undefined && keepPreviousData && sameClient && JSON.parse(published.key)[0] === op && (op !== "task.get" || JSON.parse(JSON.parse(published.key)[1]).id === (params as { id?: string } | null)?.id) ? { data: published.state.data } : {}),
  };
  return { ...result, updating: result.loading && result.data !== undefined, setData: (data: T) => query.setData(op, serialized, data), reload: () => { if (enabled) query.refresh(); } };
}
/** Delay refresh feedback so fast reads do not blink. No animation is required. */
export function useDelayedBusy(pending: boolean) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pending) { setBusy(false); return; }
    const timer = setTimeout(() => setBusy(true), 150);
    return () => clearTimeout(timer);
  }, [pending]);
  return pending && busy;
}
export function useAction() {
  const runner = useActions();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [message, setMessage] = useState("");
  const pending = useRef(false);
  const context = useTaskContext();
  const unavailable = context && (!context.state.connected || context.state.sessionEnded) ? "Reconnecting… Service actions are available when pacer reconnects." : undefined;
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
  return { busy, error, message, run, unavailable };
}
export function useDraft<T extends { [K in keyof T]: string }>(key: string, defaults: T, initialize: (saved: T) => T = saved => saved) {
  const scope = useWorkspaceKey(undefined, key);
  const [draft, setDraft] = useWorkspaceState(scope, `draft:${key}`, defaults);
  const initialized = useRef<{ scope: string; source: T; value: T }>();
  if (!initialized.current || initialized.current.scope !== scope) initialized.current = { scope, source: draft, value: initialize(draft) };
  const value = draft === initialized.current.source ? initialized.current.value : draft;
  const clearDraft = () => { workspaceManager.remove(scope, `draft:${key}`); initialized.current = undefined; };
  return [value, setDraft, clearDraft] as const;
}
export { Dialog } from "../ds/Dialog";
export function TaskLink({ id, children }: { id: string; children: ComponentChildren }) { return <TextAction className="pc-text-action" href={taskHref(id)}>{children}</TextAction>; }
