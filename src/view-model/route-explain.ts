import type { RouteExplanation } from "../core/dispatch-explain";
import type { Reason } from "../dispatch/reasons";
import { clock } from "./time";

/** A reason as clients receive it: the code may be newer than this client knows (P4), so it is a plain string here. */
export type ExplainReason = Omit<Reason, "code" | "text"> & { code: string; text?: string };
export interface ExplainLabels { executor: (id: string) => string; step: (id: string) => string; now: number }

const num = (value: unknown) => (typeof value === "number" ? String(Math.round(value)) : "an unknown number of");
const when = (value: unknown, now: number) => (typeof value === "number" ? clock(value, now) : typeof value === "string" ? value : "");

/** Plain copy for each `dispatch.explain` reason code (UI-12). Codes this client does not know get generic copy, never the raw code. */
const copy: Record<string, (facts: Reason["facts"], labels: ExplainLabels) => string> = {
  step_match: (f, l) => `It matched the ${l.step(String(f.stepId))} step${f.kind ? ` for ${f.kind} tasks` : ""}.`,
  capacity_comfortable: f => `${num(f.headroomPct)}% of its budget window is free, enough to run comfortably.`,
  capacity_usable: f => `${num(f.headroomPct)}% of its budget window is free: usable, but not comfortable.`,
  capacity_unknown: () => "Its remaining capacity is not measured.",
  override: (f, l) => `You asked for ${l.executor(String(f.executor))} for this task.`,
  planner_account: () => "It shares the planner's account and is kept for planning.",
  runner_disabled: () => "It is switched off.",
  not_configured: () => "It is not fully set up.",
  blocked_by_user: () => "You blocked it.",
  quota_exhausted: (f, l) => (f.resetsAt ? `Its budget is used up until ${when(f.resetsAt, l.now)}.` : "Its budget is used up."),
  not_installed: () => "Its command-line tool is not installed.",
  signed_out: () => "It is signed out.",
  unavailable: () => "It is not available right now.",
  ineligible: () => "It cannot take work right now.",
  runner_unhealthy: () => "It reported a problem with itself.",
  requirements_not_met: () => "It does not meet the task's requirements.",
  pinned_to_other_model: () => "The task asks for a different model.",
  executor_busy: f => `It is busy: ${num(f.used)} of ${num(f.limit)} slots are running work.`,
  machine_busy: f => `This machine is busy: ${num(f.used)} of ${num(f.limit)} slots are running work.`,
  host_unreachable: f => `Its host, ${f.host}, cannot be reached.`,
  host_reachability_unknown: f => `Its host, ${f.host}, has not been checked recently.`,
  host_paused: f => `Its host, ${f.host}, is paused.`,
  repo_not_on_host: f => `The repository is not set up on ${f.host}.`,
  needs_new_worktree: () => "Remote executors need a new worktree.",
  local_grant_required: () => "Delegating from a parent task needs a local executor.",
  enforcement_uncertified: () => "Its native subagent control is not verified.",
  other_exclusion: () => "It cannot take this task right now.",
  step_kind_mismatch: () => "The step is for a different kind of task.",
  step_no_candidates: () => "No executor qualified for this step.",
  no_step_matched: () => "No step in the choice ladder has an executor that can take it.",
  paused: (f, l) => (f.until ? `Dispatch is paused until ${when(f.until, l.now)}.` : "Dispatch is paused."),
  engine_failed: f => `The decision engine ${f.validation === "timeout" ? "timed out" : "returned an invalid choice"}, so nothing was chosen.`,
  override_unavailable: (f, l) => `${l.executor(String(f.requested))} cannot take the task, so the ladder's choice is used instead.`,
  planner_not_measured: () => "Planner tokens are not measured yet.",
  too_few_samples: f => `Only ${num(f.samples)} comparable reviewed tasks so far; ${num(f.needed)} are needed for an estimate.`,
  planner_is_executor: () => "The planner's account is also the chosen executor.",
  cached_preview: () => "This uses cached readings and reserves nothing, so the real choice may differ.",
  capacity_unmeasured: () => "Remaining capacity is unknown for an executor.",
  default_model_unresolved: () => "An executor's default model is not known yet.",
  enforcement_unverified: () => "Native subagent control has not been checked yet.",
  engine_not_running: () => "The plugin decision engine is not running, so the choice ladder was used.",
  learning_unavailable: () => "Learned fit was skipped because there is no task history yet.",
  tasks_unavailable: () => "Running tasks could not be read, so none were counted.",
  reserved_capacity: () => "Capacity held by running work may change the choice.",
  admission_hooks: () => "Configured admission checks are not run by this preview.",
};
export function reasonCopy(reason: ExplainReason, labels: ExplainLabels): string {
  return Object.hasOwn(copy, reason.code) ? copy[reason.code]!(reason.facts ?? {}, labels) : "Another condition applies.";
}

export function explainHeadline(result: Pick<RouteExplanation, "outcome" | "chosen">, labels: ExplainLabels): string {
  const who = result.chosen ? labels.executor(result.chosen.executor) : "";
  if (result.outcome === "override" && who) return `${who}, as you asked`;
  if (result.outcome === "select" && who) return `Pacer would choose ${who}`;
  if (result.outcome === "queue") return "Pacer would queue this task";
  return "No executor can take this task";
}
export function modelCopy(chosen: NonNullable<RouteExplanation["chosen"]>): string {
  return chosen.model.kind === "exact" ? chosen.model.id : "Agent default model";
}
export function plannerCopy(planner: RouteExplanation["planner"], labels: ExplainLabels): string {
  if (planner.state === "estimate") return `Planner cost: about ${planner.tokens.median.toLocaleString("en-US")} tokens (80% of tasks under ${planner.tokens.p80.toLocaleString("en-US")}), from ${planner.samples} similar tasks.`;
  // An unknown cost carries only its code, so too_few_samples has no counts to show here.
  return `Planner cost unknown. ${planner.reason === "too_few_samples" ? "There are not enough similar reviewed tasks for an estimate yet." : reasonCopy({ code: planner.reason, outcome: "info", facts: {} }, labels)}`;
}
