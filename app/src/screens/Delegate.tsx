import { useEffect, useMemo, useState } from "preact/hooks";
import type { RepoRef } from "../../../src/api/read-model/types";
import { executorLabel } from "../../../src/view-model/words";
import { Button } from "../ds/Button";
import { blankDelegate, delegateParams, delegateRoutingParams, initialDelegateDraft, kinds, taskHref, type TaskSummary } from "../model/tasks";
import { routingStatus } from "../model/executors";
import { draftStorage } from "../model/draft";
import type { Account } from "../model/accounts";
import type { Routing } from "../model/home";
import { Dialog, ErrorMessage, useAction, useDraft, useQuery, useTaskContext } from "./task-shared";

export function handleDelegateKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "isComposing" | "repeat" | "preventDefault" | "stopPropagation">,
  submit: () => void, busy = false,
) {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
  event.preventDefault(); event.stopPropagation();
  if (!busy && !event.repeat) submit();
}
export function DelegateRoutingPreview({ routing, executor, accounts = [], loading = false }: { routing?: Routing; executor: string; accounts?: Account[]; loading?: boolean }) {
  const next = routing?.ranked[0];
  return <p className="muted" aria-live="polite">{executor
    ? `Goes to ${executorLabel(executor, accounts)} · selected executor`
    : loading ? "Checking routing…"
    : next ? `Goes to ${executorLabel(next.id, accounts)} now · next in line`
    : "No executor available now."}</p>;
}
const lastRepoStorage = () => draftStorage("pacer.delegate.last-repo", { repo: "" }, {
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key),
});
type RepoChoice = RepoRef & { branches: string[] };
/** Delegate over the current screen: goal, done-when command, repo (the filter by default), branch, executor. */
export function Delegate({ close, filterRepo = null }: { close: () => void; filterRepo?: string | null }) {
  const { state } = useTaskContext();
  const ops = state.features.ops, current = ops.has("repo.list");
  const [draft, setDraft, clearDraft] = useDraft("pacer.delegate.v2", blankDelegate, saved => initialDelegateDraft(saved, filterRepo, lastRepoStorage().read().repo));
  const requestId = useMemo(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, []);
  const [validation, setValidation] = useState<unknown>();
  const [goal, setGoal] = useState(draft.goal);
  useEffect(() => { const t = setTimeout(() => setGoal(draft.goal.trim()), 300); return () => clearTimeout(t); }, [draft.goal]);
  // useQuery always runs, so an older service (no repo.list) gets a harmless version read instead.
  const repos = useQuery<RepoChoice[]>(current ? "repo.list" : "version.get", {});
  const choices: RepoChoice[] = current && Array.isArray(repos.data) ? repos.data : [];
  const routing = useQuery<Routing>("routing.route", delegateRoutingParams(draft, current, goal));
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  const action = useAction();
  const field = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const next = routing.data?.ranked[0];
  const branches = choices.find(r => r.key === draft.repo)?.branches ?? [];
  return <Dialog title="Delegate a task" close={close}><form className="pc-form" onKeyDown={event => handleDelegateKey(event, () => event.currentTarget.requestSubmit(), action.busy)} onSubmit={event => {
    event.preventDefault(); setValidation(undefined);
    try {
      const params = delegateParams(draft, ops, requestId, choices.map(r => r.key));
      void action.run<TaskSummary>("task.delegate", params, task => { lastRepoStorage().write({ repo: draft.repo }); clearDraft(); close(); location.hash = taskHref(task.task_id); });
    } catch (error) { setValidation(error); }
  }}>
    <label htmlFor="delegate-goal" className="field">Goal<textarea id="delegate-goal" required rows={3} value={draft.goal} onInput={e => field("goal", e.currentTarget.value)} /></label>
    <label htmlFor="delegate-acceptance" className="field">Done when (command, optional)<input id="delegate-acceptance" className="mono" placeholder="bun test" value={draft.acceptance} onInput={e => field("acceptance", e.currentTarget.value)} /></label>
    <div className="form-row">
      {current
        ? <label htmlFor="delegate-repo" className="field">Repository<select className="pc-select" id="delegate-repo" required value={draft.repo} onChange={e => { field("repo", e.currentTarget.value); field("base", ""); }}><option value="">Choose…</option>{choices.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select><ErrorMessage error={repos.error} /></label>
        : <label htmlFor="delegate-repo" className="field">Repository<input id="delegate-repo" required className="mono" placeholder="Absolute repository path" value={draft.repo} onInput={e => field("repo", e.currentTarget.value)} /></label>}
      {current && <label htmlFor="delegate-base" className="field">Branch<select className="pc-select" id="delegate-base" value={draft.base} onChange={e => field("base", e.currentTarget.value)}><option value="">Current branch</option>{branches.map(b => <option key={b} value={b}>{b}</option>)}</select></label>}
    </div>
    <label htmlFor="delegate-kind" className="field">Kind (optional)<select className="pc-select" id="delegate-kind" value={draft.kind} onChange={e => field("kind", e.currentTarget.value)}>
      <option value="">Automatic</option>{kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}
    </select></label>
    <label htmlFor="delegate-executor" className="field">Executor<select className="pc-select" id="delegate-executor" value={draft.executor} onChange={e => field("executor", e.currentTarget.value)}>
      <option value="">Automatic{next ? ` (${executorLabel(next.id, accounts.data ?? [])} next)` : ""}</option>
      {routing.data?.ranked.map(r => <option key={r.id} value={r.id}>{executorLabel(r.id, accounts.data ?? [])} · {routingStatus(r).label}</option>)}
    </select></label>
    <DelegateRoutingPreview routing={routing.data} executor={draft.executor} accounts={accounts.data} loading={routing.loading} />
    <div aria-live="polite"><ErrorMessage error={validation ?? action.error ?? routing.error} /></div>
    <p className="muted">⌘Enter / Ctrl+Enter to delegate</p>
    <div className="row"><Button type="submit" variant="primary" disabled={action.busy} aria-keyshortcuts="Meta+Enter Control+Enter">{action.busy ? "Delegating…" : "Delegate"}</Button><Button onClick={close}>Cancel</Button></div>
  </form></Dialog>;
}
