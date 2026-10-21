import { eligibilityPresentation } from "./eligibility";
import { executorRowStatus, paceStatus } from "./words";
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
  if (executor.stale && executor.usedPct !== null) return { ...paceStatus("unknown"), label: "Historical usage" };
  const planner = snapshot.planner;
  const verdict = planner?.runner === executor.id ? planner.verdict : snapshot.accounts?.find(a => a.executors.includes(executor.id) || a.name === executor.account)?.verdict;
  return paceStatus(verdict ?? "unknown");
}

export function executorEligibility(executor: ExecutorRow, now: number) {
  const eligibility = eligibilityPresentation(executor.eligibility, now);
  if (executor.eligibility) {
    const warning = executor.state === "failing"
      ? [executorRowStatus(executor).label, executor.reason].filter(Boolean).join(" · ")
      : null;
    return { ...eligibility, detail: [eligibility.detail, executor.untested ? "Not tested" : null, warning].filter(Boolean).join(" · ") };
  }
  // Older snapshots still carry operational state, but "ready" is not evidence
  // that execution is eligible.
  const operational = !executor.enabled ? executorRowStatus({ state: "disabled" }) : executorRowStatus(executor);
  return executor.state !== "ready" || !executor.enabled || executor.untested
    ? { ...eligibility, ...operational, detail: executor.reason || eligibility.detail }
    : eligibility;
}

export function accountUsageFreshness(account: import("../api/read-model/types").AccountSummary) {
  const historical = (account.usedPct !== null || account.spendUsdWeek != null)
    && (account.stale !== false || account.eligibility?.budget === "unknown");
  if (!historical) return null;
  const ageS = account.capturedAt == null || !account.eligibility ? null
    : Math.max(0, account.eligibility.evaluatedAt - account.capturedAt);
  const age = ageS === null ? "Observation time unknown"
    : `observed ${ageS < 60 ? `${Math.floor(ageS)}s` : ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`} ago`;
  return `Historical usage · ${age}`;
}
