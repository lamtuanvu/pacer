import { useState } from "preact/hooks";
import { Button } from "../ds/Button";
import { blankDelegate, delegateParams, kinds, recentRepos, taskHref, type TaskSummary } from "../model/tasks";
import { executorLabel } from "../../../src/view-model/words";
import { routingStatus } from "../model/executors";
import type { Routing } from "../model/home";
import { Dialog, ErrorMessage, useAction, useDraft, useQuery } from "./task-shared";
function readRepos(): string[] { try { const paths = JSON.parse(sessionStorage.getItem("pacer.repos") ?? "[]"); return Array.isArray(paths) ? paths.filter(p => typeof p === "string") : []; } catch { return []; } }
export function Delegate({ close }: { close: () => void }) {
  const [draft, setDraft, clearDraft] = useDraft("pacer.delegate", blankDelegate);
  const [validation, setValidation] = useState<unknown>();
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  const routing = useQuery<Routing>("routing.route", { kind: draft.kind });
  const action = useAction();
  const field = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const repos = readRepos();
  return <Dialog title="Delegate a task" close={close}><form onSubmit={event => {
    event.preventDefault(); setValidation(undefined);
    try {
      const params = delegateParams(draft);
      void action.run<TaskSummary>("task.delegate", params, task => {
        try { sessionStorage.setItem("pacer.repos", JSON.stringify(recentRepos([params.repo, ...repos]))); } catch { /* unavailable */ }
        clearDraft(); close(); location.hash = taskHref(task.task_id);
      });
    } catch (error) { setValidation(error); }
  }}>
    <label htmlFor="delegate-goal" className="field">Goal<textarea id="delegate-goal" required rows={3} value={draft.goal} onInput={e => field("goal", e.currentTarget.value)} /></label>
    <label htmlFor="delegate-repository" className="field">Repository<input id="delegate-repository" required list="recent-repos" placeholder="Absolute repository path" value={draft.repo} onInput={e => field("repo", e.currentTarget.value)} /></label>
    <datalist id="recent-repos">{repos.map(repo => <option key={repo} value={repo} />)}</datalist>
    <div className="form-row"><label htmlFor="delegate-kind" className="field">Kind<select id="delegate-kind" value={draft.kind} onChange={e => { field("kind", e.currentTarget.value); field("executor", ""); }}>{kinds.map(kind => <option key={kind}>{kind}</option>)}</select></label>
    <label htmlFor="delegate-executor" className="field">Executor<select id="delegate-executor" value={draft.executor} onChange={e => field("executor", e.currentTarget.value)}><option value="">Automatic{routing.data?.ranked[0] ? ` (${executorLabel(routing.data.ranked[0].id, accounts.data ?? [])} next)` : ""}</option>{routing.data?.ranked.map(runner => <option key={runner.id} value={runner.id}>{executorLabel(runner.id, accounts.data ?? [])} · {routingStatus(runner).label}</option>)}</select><ErrorMessage error={routing.error} /></label></div>
    <div className="form-row"><label htmlFor="delegate-worktree" className="field">Worktree<select id="delegate-worktree" value={draft.worktree} onChange={e => field("worktree", e.currentTarget.value)}><option value="auto">Automatic</option><option value="new">New worktree</option><option value="current">Current worktree</option></select></label>
    <label htmlFor="delegate-timeout" className="field">Timeout (minutes)<input id="delegate-timeout" type="number" required min={1} max={240} value={draft.timeout} onInput={e => field("timeout", e.currentTarget.value)} /></label></div>
    <label htmlFor="delegate-acceptance" className="field">Acceptance command (optional)<input id="delegate-acceptance" value={draft.acceptance} onInput={e => field("acceptance", e.currentTarget.value)} /></label>
    <div aria-live="polite"><ErrorMessage error={validation ?? action.error} /></div>
    <div className="row"><Button type="submit" variant="primary" disabled={action.busy}>{action.busy ? "Delegating…" : "Delegate"}</Button><Button onClick={close}>Cancel</Button></div>
  </form></Dialog>;
}
