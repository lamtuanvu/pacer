import { useState } from "preact/hooks";
import { Card } from "../ds/Card";
import { Button } from "../ds/Button";
import { nextTaskLimit, taskCounts, tasksModel, type TaskSummary, type TaskTab } from "../model/tasks";
import { Delegate } from "./Delegate";
import { ErrorMessage, TaskRow, useDraft, useQuery, useTaskContext } from "./task-shared";
export function Tasks() {
  const { state } = useTaskContext();
  const [tab, setTab] = useState<TaskTab>("running"), [limit, setLimit] = useState(20), [delegate, setDelegate] = useState(false);
  const accounts = useQuery<import("../model/accounts").Account[]>("account.list", {});
  const tasks = useQuery<TaskSummary[]>("task.list", { limit }, JSON.stringify(state.snapshot?.tasks));
  const [saved, setSaved] = useDraft("pacer.tasks", { dismissed: "[]" });
  let dismissed: string[] = [];
  try { const parsed = JSON.parse(saved.dismissed); if (Array.isArray(parsed)) dismissed = parsed.filter(id => typeof id === "string"); } catch { /* invalid saved input */ }
  const rows = tasksModel(tasks.data ?? [], state.snapshot ?? [], tab, dismissed, accounts.data ?? []);
  const counts = state.snapshot ? taskCounts(state.snapshot) : null;
  const more = nextTaskLimit(limit);
  return <section className="screen"><div className="top"><h1>Tasks</h1><span className="grow" /><Button variant={delegate ? "secondary" : "primary"} onClick={() => setDelegate(true)}>Delegate a task</Button></div>
    <div className="tabs" aria-label="Task state">{([['running', 'Running'], ['review', 'Waiting for review'], ['history', 'History']] as const).map(([key, label]) => <Button key={key} className={tab === key ? "tab on" : "tab"} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}{counts && key !== "history" ? ` (${counts[key]})` : ""}</Button>)}</div>
    <ErrorMessage error={tasks.error} />{tasks.loading && !tasks.data ? <p>Loading tasks…</p> : <Card>{rows.map(task => <TaskRow key={task.id} task={task} reload={tasks.reload} onDismiss={ids => setSaved({ dismissed: JSON.stringify([...new Set([...dismissed, ...ids])]) })} />)}{!rows.length && <p className="muted">No tasks here yet. Delegate one, or ask your planner to.</p>}</Card>}
    <div className="row"><span className="muted">Showing {rows.length} from the {tasks.data?.length ?? 0} most recent tasks.</span>{more && tasks.data && tasks.data.length >= limit && <Button disabled={tasks.loading} onClick={() => setLimit(more)}>Load older tasks</Button>}{limit === 200 && tasks.data?.length === 200 && <span className="muted">The API returns up to 200 recent tasks.</span>}</div>
    {delegate && <Delegate close={() => setDelegate(false)} />}
  </section>;
}
