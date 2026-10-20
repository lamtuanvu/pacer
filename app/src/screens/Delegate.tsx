import { reconcileExecutor } from "../model/project-strategies";
import { Field, TextInput, TextArea, Select } from "../ds/Controls";

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
export function DelegateRoutingPreview({ routing, executor, accounts = [], loading = false, repoLabel }: { routing?: Routing; executor: string; accounts?: Account[]; loading?: boolean; repoLabel?: string }) {
  const next = routing?.ranked[0];
  return <p className="muted" aria-live="polite">{executor
    ? `Goes to ${executorLabel(executor, accounts)} · selected executor`
    : loading ? "Checking routing…"
    : next ? `Goes to ${executorLabel(next.id, accounts)} now · next in line`
    : "No executor available now."}{routing?.policy && <> · Project order{repoLabel ? ` for ${repoLabel}` : " for this repository"}</>}{!executor && !loading && !next && routing?.policy && routing.excluded.length > 0 && <>. {routing.excluded.map(row=>`${executorLabel(row.id,accounts)}: ${row.reason}`).join("; ")}</>}</p>;
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
  useEffect(() => {
    if (!routing.loading && routing.data) setDraft(previous => {
      const executor = reconcileExecutor(previous.executor, routing.data);
      return executor === previous.executor ? previous : { ...previous, executor };
    });
  }, [routing.data, routing.loading]);
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  const action = useAction();
  const field = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value, ...(key === "repo" ? {executor:""} : {}) }));
  const next = routing.data?.ranked[0];
  const blocked=action.busy || (ops.has("project.strategy.get") && (routing.loading || !!routing.error));
  const branches = choices.find(r => r.key === draft.repo)?.branches ?? [];
  return <Dialog title="Delegate a task" close={close}><form className="pc-form" onKeyDown={event => handleDelegateKey(event, () => event.currentTarget.requestSubmit(), blocked)} onSubmit={event => {
    event.preventDefault();
    if (blocked) return;
    setValidation(undefined);
    try {
      const params = delegateParams(draft, ops, requestId, choices.map(r => r.key));
      void action.run<TaskSummary>("task.delegate", params, task => { lastRepoStorage().write({ repo: draft.repo }); clearDraft(); close(); location.hash = taskHref(task.task_id); });
    } catch (error) { setValidation(error); }
  }}>
    <Field label={<> Goal </>}><TextArea id="delegate-goal" required rows={3} value={draft.goal} onInput={e => field("goal", e.currentTarget.value)} /></Field>
    <Field label={<> Done when (command, optional) </>}><TextInput id="delegate-acceptance" className="mono" placeholder="bun test" value={draft.acceptance} onInput={e => field("acceptance", e.currentTarget.value)} /></Field>
    <div className="form-row">
      {current
        ? <Field label={<> Repository </>}><Select className="pc-select" id="delegate-repo" required value={draft.repo} onChange={e => { field("repo", e.currentTarget.value); field("base", ""); }}><option value="">Choose…</option>{choices.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</Select><ErrorMessage error={repos.error} /></Field>
        : <Field label={<> Repository </>}><TextInput id="delegate-repo" required className="mono" placeholder="Absolute repository path" value={draft.repo} onInput={e => field("repo", e.currentTarget.value)} /></Field>}
      {current && <Field label={<> Branch </>}><Select className="pc-select" id="delegate-base" value={draft.base} onChange={e => field("base", e.currentTarget.value)}><option value="">Current branch</option>{branches.map(b => <option key={b} value={b}>{b}</option>)}</Select></Field>}
    </div>
    <Field label={<> Kind (optional) </>}><Select className="pc-select" id="delegate-kind" value={draft.kind} onChange={e => field("kind", e.currentTarget.value)}>
      <option value="">Automatic</option>{kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}
    </Select></Field>
    <Field label={<> Executor </>}><Select className="pc-select" id="delegate-executor" value={draft.executor} onChange={e => field("executor", e.currentTarget.value)}>
      <option value="">Automatic{next ? ` (${executorLabel(next.id, accounts.data ?? [])} next)` : ""}</option>
      {routing.data?.ranked.map(r => <option key={r.id} value={r.id}>{executorLabel(r.id, accounts.data ?? [])} · {routingStatus(r).label}</option>)}
    </Select></Field>
    <DelegateRoutingPreview routing={routing.data} executor={draft.executor} accounts={accounts.data} loading={routing.loading} repoLabel={choices.find(r=>r.key===draft.repo)?.label} />
    <div aria-live="polite"><ErrorMessage error={validation ?? action.error ?? routing.error} /></div>
    <p className="muted">⌘Enter / Ctrl+Enter to delegate</p>
    <div className="row"><Button type="submit" variant="primary" disabled={blocked} aria-keyshortcuts="Meta+Enter Control+Enter">{action.busy ? "Delegating…" : "Delegate"}</Button><Button onClick={close}>Cancel</Button></div>
  </form></Dialog>;
}
