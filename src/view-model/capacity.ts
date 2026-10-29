import { eligibilityPresentation } from "./eligibility";
import { percentage, executorRowStatus, paceStatus } from "./words";
import type { ExecutorRow } from "../api/read-model/types";
import type { ClientMachine, ClientSnapshot, ClientTask } from "./snapshot";

/** The machine's fixed cap, or null without one. Reads hardCap; 3.0 services sent only max. */
export function machineHardCap(machine: Pick<ClientMachine, "max" | "hardCap" | "unlimited"> | undefined): number | null {
  if (!machine || machine.unlimited) return null;
  if (machine.hardCap !== undefined) return machine.hardCap;
  return machine.max >= Number.MAX_SAFE_INTEGER ? null : machine.max;
}

export function capacityNote(executor: ExecutorRow, snapshot: ClientSnapshot): string | null {
  if (!executor.limitedBy) return null;
  const cap = executor.limitedBy === "machine" ? machineHardCap(snapshot.machine) : snapshot.hosts?.find(h => h.alias === executor.host)?.maxTasks;
  const place = executor.limitedBy === "machine" ? "this machine" : executor.host ?? "this host";
  return cap === undefined || cap === null ? `Limited by ${place}` : `Limited to ${cap} by ${place}`;
}

const formatLoad = (n: number) => String(Math.round(n * 10) / 10);

/** Plain words for a machine-guard wait, from what the guard observed. */
export function machineWaitWords(queue: NonNullable<ClientTask["queue"]>): string | null {
  if (queue.reason === "machine_memory_pressure") return `Waiting: memory pressure ${queue.machine?.memoryPressure ?? "high"}`;
  if (queue.reason === "machine_load") {
    const load = queue.machine?.loadPerCore, limit = queue.machine?.loadLimit;
    return load !== undefined && limit !== undefined ? `Waiting: load ${formatLoad(load)}/core over limit ${formatLoad(limit)}` : "Waiting: this machine is under heavy load";
  }
  return null;
}

export function queueWait(task: ClientTask, snapshot: ClientSnapshot): string {
  const queue = task.queue;
  const machine = queue ? machineWaitWords(queue) : null;
  if (machine) return machine;
  if (queue?.reason !== "no_slot") return queue?.reason === "paused" ? "Waiting: delegation is paused" : "Queued";
  const place = queue.limit === "machine" ? "this machine" : queue.limit === "host" ? task.host ?? "this host" : "this executor";
  const hardCap = machineHardCap(snapshot.machine);
  const machineCap = snapshot.machine && hardCap !== null ? {used: snapshot.machine.used, max: hardCap} : undefined;
  const cap = queue.capacity ?? (queue.limit === "machine" ? machineCap : undefined);
  return queue.limit && cap ? `Waiting: ${place} is running ${cap.used} of ${cap.max}` : "Waiting for parallel task capacity";
}

/** Read pace from its authoritative account/planner verdict, never executor readiness or a percentage threshold. */
export function executorPace(executor: ExecutorRow, snapshot: ClientSnapshot) {
  if (executor.stale && executor.usedPct !== null) return { ...paceStatus("unknown"), label: "Historical usage" };
  const planner = snapshot.planner;
  const verdict = planner?.runner === executor.id ? planner.verdict : snapshot.accounts?.find(a => a.executors?.includes(executor.id) || a.name === executor.account)?.verdict;
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
  return ageS === null ? "Stale reading · refresh to use"
    : `Reading ${ageS < 60 ? `${Math.floor(ageS)}s` : ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`} old`;
}

/** Board vocabulary for readiness; routing decisions remain untouched. */
export function executorReadiness(executor: ExecutorRow, snapshot: ClientSnapshot) {
  const now = snapshot.at ?? Date.now() / 1000;
  const technical = executorEligibility(executor, now);
  const account = snapshot.accounts?.find(a => a.executors?.includes(executor.id) || a.name === executor.account);
  const decision = executor.eligibility;
  const codes = decision?.reasons.map(r => r.code) ?? [];
  const stale = executor.stale || account?.stale;
  const age = account?.capturedAt != null ? Math.max(0, now - account.capturedAt)
    : decision?.evidenceAgeS == null ? null : Math.max(0, decision.evidenceAgeS + now - decision.evaluatedAt);
  let label = "Ready", tone = "good" as import("./words").StatusTone, reason = "Ready to take work";
  if (!executor.enabled || executor.state === "disabled") { label = "Off"; tone = "neutral"; reason = "Takes work is turned off"; }
  else if (codes.includes("subscription_missing")) { label = "Cannot take work"; tone = "bad"; reason = "No active subscription"; }
  else if (codes.some(code => ["authentication_failed", "signed_out"].includes(code))) { label = "Cannot take work"; tone = "bad"; reason = "Sign-in is required"; }
  else if (executor.state === "failing" && decision?.state !== "eligible" && executor.recentFailures > 0) { label = "Cannot take work"; tone = "bad"; reason = `${executor.recentFailures} recent failures`; }
  else if (stale || codes.includes("budget_expired_or_unknown")) { label = "Skipped"; tone = "warn"; reason = age == null ? "Usage reading needs refreshing" : `Usage reading is ${age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`} old`; }
  else if (decision?.state === "ineligible" || (["down", "blocked", "exhausted"].includes(executor.state) || executor.state === "failing" && decision?.state !== "eligible")) {
    label = "Cannot take work"; tone = "bad";
    reason = executor.state === "blocked" || codes.includes("blocked") ? "Blocked by you" : executor.state === "exhausted" || codes.includes("budget_exhausted") ? "Out of quota" : codes.includes("not_installed") ? "Agent needs installing" : executor.lastCheck?.passed === false ? "Last test task failed" : "Agent needs attention";
  }
  else if (executor.untested || !decision || decision.state === "uncertain") { label = "Skipped"; tone = "warn"; reason = executor.untested ? "Run a test task to check readiness" : "Refresh to confirm availability"; }
  else if (executor.state === "full") { label = "Skipped"; tone = "neutral"; reason = "All parallel slots are in use"; }
  else if (executorPace(executor, snapshot).label === "Ahead of pace") { label = "Ahead of pace"; tone = "warn"; reason = "Used before others only for capable work"; }
  if ((label === "Ready" || label === "Ahead of pace") && executor.state === "failing" && executor.recentFailures > 0) reason = `${executor.recentFailures} recent failures`;
  return { label, tone, glyph: tone === "good" ? "✓" : tone === "neutral" ? "■" : "!", reason,
    tooltip: [technical.label, technical.detail, technical.age, executor.sub].filter(Boolean).join(" · ") };
}

export function executorWeekUsage(executor: ExecutorRow, snapshot: ClientSnapshot): string {
  const account = snapshot.accounts?.find(a => a.executors?.includes(executor.id) || a.name === executor.account);
  if (executor.stale || account?.stale || executor.eligibility?.reasons.some(r => r.code === "budget_expired_or_unknown")) return "Stale · refresh to use";
  if (account?.verdict === "UNMETERED" || executor.eligibility?.budget === "not_required") return "Unmetered";
  if (executor.usedPct == null) return "No usage reported";
  const window = account?.window === "weekly" ? "week" : account?.window ?? "week";
  const reset = account?.resetsAt == null ? "" : ` · resets ${new Date(account.resetsAt * 1000).toLocaleDateString("en-GB", { weekday: "short" })}`;
  return `${percentage(executor.usedPct)} of ${window}${reset}`;
}
