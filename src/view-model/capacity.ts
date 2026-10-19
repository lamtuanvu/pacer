import { paceStatus } from "./words";
import type { ExecutorRow } from "../api/read-model/types";
import type { ClientSnapshot, ClientTask } from "./snapshot";

export function capacityNote(executor: ExecutorRow, snapshot: ClientSnapshot): string | null {
  if (!executor.limitedBy) return null;
  const cap = executor.limitedBy === "machine" ? snapshot.machine?.max : snapshot.hosts?.find(h => h.alias === executor.host)?.maxTasks;
  const place = executor.limitedBy === "machine" ? "this machine" : executor.host ?? "this host";
  return cap === undefined ? `Limited by ${place}` : `Limited to ${cap} by ${place}`;
}

export function queueWait(task: ClientTask, snapshot: ClientSnapshot): string {
  const queue = task.queue;
  if (queue?.reason !== "no_slot") return queue?.reason === "paused" ? "Waiting: delegation is paused" : "Queued";
  const place = queue.limit === "machine" ? "this machine" : queue.limit === "host" ? task.host ?? "this host" : "this executor";
  const cap = queue.capacity ?? (queue.limit === "machine" ? snapshot.machine : undefined);
  return queue.limit && cap ? `Waiting: ${place} is running ${cap.used} of ${cap.max}` : "Waiting for parallel task capacity";
}

/** Read pace from its authoritative account/planner verdict, never executor readiness or a percentage threshold. */
export function executorPace(executor: ExecutorRow, snapshot: ClientSnapshot) {
  const planner = snapshot.planner;
  const verdict = planner?.runner === executor.id ? planner.verdict : snapshot.accounts?.find(a => a.executors.includes(executor.id) || a.name === executor.account)?.verdict;
  return paceStatus(verdict ?? "unknown");
}
