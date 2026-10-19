import { DelegateRoutingPreview } from "./Delegate";
import { Field, TextInput, Select } from "../ds/Controls";

import { useEffect, useMemo, useState } from "preact/hooks";
import { repos as snapshotRepos } from "../../../src/view-model/selectors";
import { executorLabel } from "../../../src/view-model/words";
import { Button } from "../ds/Button";
import { delegateParams, taskHref, type TaskSummary } from "../model/tasks";
import type { Routing } from "../model/home";
import { ErrorMessage, useAction, useQuery, useTaskContext } from "./task-shared";

/** The Overview's one-line delegate: goal, repo (the filter by default) and where it goes now. The full dialog is the top bar's Delegate. */
export function QuickDelegate({ filterRepo }: { filterRepo: string | null }) {
  const { state } = useTaskContext();
  const ops = state.features.ops;
  const repos = state.snapshot ? snapshotRepos(state.snapshot) : [];
  const [goal, setGoal] = useState(""), [repo, setRepo] = useState(filterRepo ?? repos[0]?.key ?? "");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(goal.trim()), 300); return () => clearTimeout(t); }, [goal]);
  useEffect(() => { if (filterRepo) setRepo(filterRepo); }, [filterRepo]);
  const requestId = useMemo(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, [goal === ""]);
  const routing = useQuery<Routing>("routing.route", ops.has("repo.list") ? { ...(debounced ? { goal: debounced } : {}), ...(repo ? { repo } : {}) } : {});
  const action = useAction();
  const [error, setError] = useState<unknown>();
  const next = routing.data?.ranked[0];
  return <form className="pc-quick" onSubmit={event => {
    event.preventDefault(); setError(undefined);
    try {
      const params = delegateParams({ goal, repo, base: "", acceptance: "", executor: "", kind: "" }, ops, requestId, repos.map(r => r.key));
      void action.run<TaskSummary>("task.delegate", params, task => { setGoal(""); location.hash = taskHref(task.task_id); });
    } catch (e) { setError(e); }
  }}>
    <Field label={<> What should be done? </>}><TextInput id="qd-goal" type="text" placeholder="e.g. Add a regression test for the cache key" value={goal} onInput={e => setGoal(e.currentTarget.value)} /></Field>
    <div className="row">
      <Select className="pc-select" id="qd-repo" aria-label="Repository" value={repo} onChange={e => setRepo(e.currentTarget.value)}>{repos.map(r => <option key={r.key} value={r.key} selected={r.key === repo}>{r.label}</option>)}</Select>
      <span className="grow" />
      <Button type="submit" size="sm" disabled={action.busy || !goal.trim() || (ops.has("project.strategy.get") && (routing.loading || !!routing.error))}>{action.busy ? "Delegating…" : "Delegate"}</Button>
    </div>
    <DelegateRoutingPreview routing={routing.data} executor="" loading={routing.loading}/>
    <ErrorMessage error={error ?? action.error ?? routing.error} />
  </form>;
}
