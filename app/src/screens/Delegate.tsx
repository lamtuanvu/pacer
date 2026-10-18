import { useEffect, useMemo, useState } from "preact/hooks";
import type { RepoRef } from "../../../src/api/read-model/types";
import { executorLabel } from "../../../src/view-model/words";
import { Button } from "../ds/Button";
import { blankDelegate, delegateParams, initialDelegateDraft, taskHref, type TaskSummary } from "../model/tasks";
import { routingStatus } from "../model/executors";
import type { Routing } from "../model/home";
import { Dialog, ErrorMessage, useAction, useDraft, useQuery, useTaskContext } from "./task-shared";

type RepoChoice = RepoRef & { branches: string[] };
/** Delegate over the current screen: goal, done-when command, repo (the filter by default), branch, executor. */
export function Delegate({ close, filterRepo = null }: { close: () => void; filterRepo?: string | null }) {
  const { state } = useTaskContext();
  const ops = state.features.ops, current = ops.has("repo.list");
  const [saved, setDraft, clearDraft] = useDraft("pacer.delegate.v2", blankDelegate);
  const draft = initialDelegateDraft(saved, filterRepo);
  const requestId = useMemo(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, []);
  const [validation, setValidation] = useState<unknown>();
  const [goal, setGoal] = useState(draft.goal);
  useEffect(() => { const t = setTimeout(() => setGoal(draft.goal.trim()), 300); return () => clearTimeout(t); }, [draft.goal]);
  // useQuery always runs, so an older service (no repo.list) gets a harmless version read instead.
  const repos = useQuery<RepoChoice[]>(current ? "repo.list" : "version.get", {});
  const choices: RepoChoice[] = current && Array.isArray(repos.data) ? repos.data : [];
  const routing = useQuery<Routing>("routing.route", current ? { ...(goal ? { goal } : {}), ...(draft.repo ? { repo: draft.repo } : {}) } : {});
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  const action = useAction();
  const field = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...initialDelegateDraft(previous, filterRepo), [key]: value }));
  const next = routing.data?.ranked[0];
  const branches = choices.find(r => r.key === draft.repo)?.branches ?? [];
  return <Dialog title="Delegate a task" close={close}><form className="pc-form" onSubmit={event => {
    event.preventDefault(); setValidation(undefined);
    try {
      const params = delegateParams(draft, ops, requestId, choices.map(r => r.key));
      void action.run<TaskSummary>("task.delegate", params, task => { clearDraft(); close(); location.hash = taskHref(task.task_id); });
    } catch (error) { setValidation(error); }
  }}>
    <label htmlFor="delegate-goal" className="field">Goal<textarea id="delegate-goal" required rows={3} value={draft.goal} onInput={e => field("goal", e.currentTarget.value)} /></label>
    <label htmlFor="delegate-acceptance" className="field">Done when (command, optional)<input id="delegate-acceptance" className="mono" placeholder="bun test" value={draft.acceptance} onInput={e => field("acceptance", e.currentTarget.value)} /></label>
    <div className="form-row">
      {current
        ? <label htmlFor="delegate-repo" className="field">Repository<select id="delegate-repo" required value={draft.repo} onChange={e => { field("repo", e.currentTarget.value); field("base", ""); }}><option value="">Choose…</option>{choices.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select><ErrorMessage error={repos.error} /></label>
        : <label htmlFor="delegate-repo" className="field">Repository<input id="delegate-repo" required className="mono" placeholder="Absolute repository path" value={draft.repo} onInput={e => field("repo", e.currentTarget.value)} /></label>}
      {current && <label htmlFor="delegate-base" className="field">Branch<select id="delegate-base" value={draft.base} onChange={e => field("base", e.currentTarget.value)}><option value="">Current branch</option>{branches.map(b => <option key={b} value={b}>{b}</option>)}</select></label>}
    </div>
    <label htmlFor="delegate-executor" className="field">Executor<select id="delegate-executor" value={draft.executor} onChange={e => field("executor", e.currentTarget.value)}>
      <option value="">Automatic{next ? ` (${executorLabel(next.id, accounts.data ?? [])} next)` : ""}</option>
      {routing.data?.ranked.map(r => <option key={r.id} value={r.id}>{executorLabel(r.id, accounts.data ?? [])} · {routingStatus(r).label}</option>)}
    </select></label>
    {next && !draft.executor && <p className="muted" aria-live="polite">Goes to {executorLabel(next.id, accounts.data ?? [])} now (next in line).</p>}
    <div aria-live="polite"><ErrorMessage error={validation ?? action.error ?? routing.error} /></div>
    <div className="row"><Button type="submit" variant="primary" disabled={action.busy}>{action.busy ? "Delegating…" : "Delegate"}</Button><Button onClick={close}>Cancel</Button></div>
  </form></Dialog>;
}
