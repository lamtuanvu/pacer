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
  const lines = [
    ...runners.map(task => `Task ${task.task_id} on ${task.runner_pacer ? `runner ${task.runner_pacer}` : "a runner from an older release"}`),
    ...hosts.map(session => `${session.kind === "terminal" ? `Terminal ${session.id.slice(0, 8)}` : `Session ${session.id}`} on ${session.pacer ? `host ${session.pacer}` : "a host from an older release"}${session.reopen_to_update ? " (Reopen to update)" : ""}`),
  ];
  return <SettingRow variant="board" label="Still on an older version" description={`They keep running until they finish. ${lines.join("; ")}.`}>{null}</SettingRow>;
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
