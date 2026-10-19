import { useEffect, useState } from "preact/hooks";
import { Field, Select } from "../../ds/Controls";
import { Button } from "../../ds/Button";
import { SectionHeading } from "../../ds/SectionHeading";
import { moveExecutor, projectDraft, type ProjectStrategyView } from "../../model/project-strategies";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { Feedback, useOperation, useResource } from "./shared";

export function ProjectStrategies({ initialData }: { initialData?: ProjectStrategyView }) {
  const { state } = useTaskContext();
  if (!["get", "list", "set", "remove"].every(op => state.features.ops.has(`project.strategy.${op}`))) return null;
  return <ProjectStrategyPicker initialData={initialData} />;
}
function ProjectStrategyPicker({ initialData }: { initialData?: ProjectStrategyView }) {
  const { state } = useTaskContext();
  const policies = useResource<ProjectStrategyView[]>("project.strategy.list", {});
  const choices = new Map((state.snapshot?.repos ?? []).map(repo => [repo.key, repo]));
  for (const policy of policies.data ?? []) if (!choices.has(policy.repo.key)) choices.set(policy.repo.key, { ...policy.repo, path: policy.repo.path ?? "" });
  if (initialData && !choices.has(initialData.repo.key)) choices.set(initialData.repo.key, { ...initialData.repo, path: initialData.repo.path ?? "" });
  const [repo, setRepo] = useState(initialData?.repo.key ?? choices.keys().next().value ?? "");
  useEffect(() => { if (!repo && choices.size) setRepo(choices.keys().next().value!); }, [repo, choices.size]);
  return <div className="pc-card pc-project-strategies">
    <SectionHeading>Project strategies</SectionHeading>
    <p className="u3-muted">Choose which executors may work on a repository, in order. This overrides global routing and stays in place when you switch strategies.</p>
    <ErrorMessage error={policies.error} />
    {choices.size ? <Field label="Project repository"><Select value={repo} onChange={event => setRepo(event.currentTarget.value)}>{[...choices.values()].map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</Select></Field> : <p>No repositories yet. Add a repository from the repository picker to configure its strategy.</p>}
    {repo && <ProjectStrategyEditor key={repo} repo={repo} initialData={initialData?.repo.key === repo ? initialData : undefined} />}
  </div>;
}
function ProjectStrategyEditor({ repo, initialData }: { repo: string; initialData?: ProjectStrategyView }) {
  const { state } = useTaskContext();
  const query = useResource<ProjectStrategyView>("project.strategy.get", { repo }, initialData);
  const view = query.data ?? initialData;
  const [draft, setDraft] = useState(view ? projectDraft(view) : undefined);
  const [dirty, setDirty] = useState(false), [add, setAdd] = useState("");
  const action = useOperation();
  useEffect(() => { if (view && !dirty && (!draft || view.rev >= draft.rev)) setDraft(projectDraft(view)); }, [view, dirty]);
  const saved = (result: ProjectStrategyView) => { query.setData(result); setDraft(projectDraft(result)); setDirty(false); setAdd(""); };
  const edit = (executors: string[]) => { setDraft(previous => previous && { ...previous, executors }); setDirty(true); };
  const disabled = !state.connected || action.busy;
  if (!view || !draft) return <><p role="status">{query.error ? "Project strategy could not be loaded." : "Loading project strategy…"}</p><ErrorMessage error={query.error}/>{query.error && <Button onClick={query.reload}>Try again</Button>}</>;
  const remaining = view.available.filter(runner => !draft.executors.includes(runner.reference));
  return <div className="pc-project-editor">
    <p><strong>{view.executors ? "Project order" : "Using global strategy"}</strong>{dirty ? " · Unsaved changes" : " · Saved"}</p>
    {view.rev !== draft.rev && <p role="status">Another client changed this strategy. Your draft is preserved. Reload the saved order before saving again.</p>}
    <ErrorMessage error={query.error}/>
    {!state.connected && <p role="status">Reconnect to save. Your draft stays here.</p>}
    <ol className="pc-project-order" aria-label="Allowed executors in priority order">
      {draft.executors.map((reference, index) => {
        const runner = view.available.find(r => r.reference === reference), label = runner?.label ?? reference;
        return <li key={reference} className="pc-project-row">
          <div className="pc-project-label"><strong>{label}</strong><span className="u3-muted">{!runner ? "Unavailable in the active strategy · " : ""}{index === 0 ? "First choice" : `Fallback ${index}`}</span></div>
          <div className="u3-actions">
            <Button size="sm" aria-label={`Move ${label} up`} aria-disabled={index === 0} disabled={disabled} onClick={() => { if (index > 0) edit(moveExecutor(draft.executors, index, -1)); }}>Move up</Button>
            <Button size="sm" aria-label={`Move ${label} down`} aria-disabled={index === draft.executors.length - 1} disabled={disabled} onClick={() => { if (index < draft.executors.length - 1) edit(moveExecutor(draft.executors, index, 1)); }}>Move down</Button>
            <Button size="sm" aria-label={`Remove ${label}`} disabled={disabled} onClick={() => edit(draft.executors.filter(value => value !== reference))}>Remove</Button>
          </div>
        </li>;
      })}
    </ol>
    <p className="u3-muted">The first choice cannot move up; the last cannot move down. Unavailable executors are skipped, and fallback stays within this list.</p>
    {remaining.length > 0 && <div className="u3-row"><Field label="Add allowed executor"><Select value={add} disabled={disabled} onChange={event => setAdd(event.currentTarget.value)}><option value="">Choose executor</option>{remaining.map(runner => <option key={runner.reference} value={runner.reference}>{runner.label}</option>)}</Select></Field>{add && <Button disabled={disabled} onClick={() => { edit([...draft.executors, add]); setAdd(""); }}>Add executor</Button>}</div>}
    {!draft.executors.length && <p role="status">Add at least one executor to save a project order. Use global strategy to remove an override.</p>}
    {!dirty && <p className="u3-muted">Make changes to save a new project order.</p>}
    <div className="u3-actions">
      <Button variant="primary" disabled={disabled || !dirty || !draft.executors.length} onClick={() => void action.run("project.strategy.set", {repo, executors:draft.executors, expect_rev:draft.rev}, saved)}>Save project strategy</Button>
      {view.executors && <Button disabled={disabled} onClick={() => void action.run("project.strategy.remove", {repo, expect_rev:draft.rev}, saved)}>Use global strategy</Button>}
      {(dirty || action.error || query.error) && <Button disabled={action.busy} onClick={() => { setDirty(false); query.reload(); }}>Reload saved order</Button>}
    </div>
    {action.busy && <p role="status">Saving project strategy…</p>}
    <Feedback action={action}/>
  </div>;
}
