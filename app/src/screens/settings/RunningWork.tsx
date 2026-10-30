import { SettingRow } from "../../ds/SettingRow";
import { useTaskContext } from "../task-shared";
import { useResource } from "./shared";

/** Mirrors the `service.work` operation result. */
export interface ServiceWork {
  pacer: string;
  tasks: { task_id: string; runner_pacer: string | null; older: boolean }[];
  sessions: { kind: "task" | "terminal"; id: string; pacer: string | null; older: boolean; reopen_to_update: boolean }[];
  counts: { tasks: number; sessions: number; older_runners: number; older_sessions: number; reopen_to_update: number };
}

export function RunningWorkList({ work }: { work: ServiceWork }) {
  const runners = work.tasks.filter(task => task.older), hosts = work.sessions.filter(session => session.older);
  if (!runners.length && !hosts.length) return null;
  return <SettingRow variant="board" label="Still on an older version" description="This work keeps running until it finishes.">
    <ul className="pc-running-work-list">
      {runners.map(task => <li key={task.task_id}>Task <a className="pc-inline-link" href={`#/tasks/${encodeURIComponent(task.task_id)}`} title={task.task_id}>{task.task_id}</a> · {task.runner_pacer ? `pacer ${task.runner_pacer}` : "started on an older pacer"}</li>)}
      {hosts.map(session => <li key={`${session.kind}-${session.id}`}>{session.kind === "terminal" ? "Terminal" : "Session"} <span title={session.id}>{session.id}</span> · {session.pacer ? `pacer ${session.pacer}` : "started on an older pacer"}{session.reopen_to_update ? " · Reopen to update" : ""}</li>)}
    </ul>
  </SettingRow>;
}

function RunningWorkResource() {
  const query = useResource<ServiceWork>("service.work", {});
  return query.data ? <RunningWorkList work={query.data} /> : null;
}

/** Shown only when the connected service offers `service.work`. */
export function RunningWork() {
  const { state } = useTaskContext();
  return state.features.ops.has("service.work") ? <RunningWorkResource /> : null;
}
