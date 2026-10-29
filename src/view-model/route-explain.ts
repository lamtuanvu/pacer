import type { RouteExplanation } from "../core/dispatch-explain";
import type { Reason, ReasonCode } from "../dispatch/reasons";
import { clock } from "./time";

/** A reason as clients receive it: the code may be newer than this client knows (P4), so it is a plain string here. */
export type ExplainReason = Omit<Reason, "code" | "text"> & { code: string; text?: string };
export interface ExplainLabels { executor: (id: string) => string; step: (id: string) => string; now: number; outcome?: RouteExplanation["outcome"] }

const num = (value: unknown) => (typeof value === "number" ? String(Math.round(value)) : "an unknown number of");
const host = (facts: Reason["facts"]) => typeof facts.host === "string" && facts.host ? `, ${facts.host},` : "";
const when = (value: unknown, now: number) => (typeof value === "number" ? clock(value, now) : typeof value === "string" ? value : "");

/** Plain copy for each `dispatch.explain` reason code (UI-12). Codes this client does not know get generic copy, never the raw code. */
const copy: Record<string, (facts: Reason["facts"], labels: ExplainLabels) => string> = {
  rank_match: () => "It ranked first among the executors that can take this kind of work.",
  no_executor_ranked: () => "No executor can take this work right now.",
  ranked_inputs_ignored: () => "Requirements, preferences and a chosen model apply only to dispatched work, so they were not used here.",
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
  host_unreachable: f => `Its host${host(f)} cannot be reached.`,
  host_reachability_unknown: f => `Its host${host(f)} has not been checked recently.`,
  host_paused: f => `Its host${host(f)} is paused.`,
  repo_not_on_host: f => `The repository is not set up on ${typeof f.host === "string" && f.host ? f.host : "its host"}.`,
  needs_new_worktree: () => "Remote executors need a new worktree.",
  local_grant_required: () => "Delegating from a parent task needs a local executor.",
  enforcement_uncertified: () => "Its native subagent control is not verified.",
  other_exclusion: () => "It cannot take this task right now.",
  step_kind_mismatch: () => "The step is for a different kind of task.",
  step_no_candidates: () => "No executor qualified for this step.",
  no_step_matched: (_f, l) => l.outcome === "queue" ? "No executor in the choice ladder is free right now." : "No step in the choice ladder has an executor that can take it.",
  paused: (f, l) => (f.until ? `Dispatch is paused until ${when(f.until, l.now)}.` : "Dispatch is paused."),
  engine_failed: f => `The decision engine ${f.validation === "timeout" ? "timed out" : "returned an invalid choice"}, so nothing was chosen.`,
  override_unavailable: (f, l) => `${l.executor(String(f.requested))} cannot take this task.`,
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
export function reasonCopy(reason: ExplainReason, labels: ExplainLabels, subjectLabel?: string): string {
  const text = Object.hasOwn(copy, reason.code) ? copy[reason.code]!(reason.facts ?? {}, labels) : "Another condition applies.";
  return subjectLabel ? `${subjectLabel}: ${text}` : text;
}

export function explainHeadline(result: Pick<RouteExplanation, "outcome" | "chosen"> & { reasons?: readonly ExplainReason[] }, labels: ExplainLabels): string {
  // A refused request names the requested executor only when nothing was chosen; otherwise the ladder's pick leads.
  const refused = result.chosen ? undefined : result.reasons?.find(reason => reason.code === "override_unavailable" || (result.outcome === "fail" && reason.code === "override"));
  const requested = refused?.facts.requested ?? refused?.facts.executor ?? refused?.subject;
  if (typeof requested === "string") return `${labels.executor(requested)} cannot take this task`;
  // The runner names the account too ("Codex · team"), which tells apart two accounts of one agent.
  const who = result.chosen ? labels.executor(result.chosen.runner) : "";
  if (result.outcome === "override" && who) return `${who}, as you asked`;
  if (result.outcome === "select" && who) return `Pacer would choose ${who}`;
  if (result.outcome === "queue") return "Pacer would hold this task until an executor can take it";
  return "No executor can take this task now";
}
export function modelCopy(chosen: NonNullable<RouteExplanation["chosen"]>): string {
  return chosen.model.kind === "exact" ? chosen.model.id : "Agent default model";
}
export function plannerCopy(planner: RouteExplanation["planner"], labels: ExplainLabels): string {
  if (planner.state === "estimate") return `Planner cost: about ${planner.tokens.median.toLocaleString("en-US")} tokens (80% of tasks under ${planner.tokens.p80.toLocaleString("en-US")}), from ${planner.samples} similar tasks.`;
  // An unknown cost carries only its code, so too_few_samples has no counts to show here.
  return `Planner cost unknown. ${planner.reason === "too_few_samples" ? "There are not enough similar reviewed tasks for an estimate yet." : reasonCopy({ code: planner.reason, outcome: "info", facts: {} }, labels)}`;
}

export type ReasonSeverity = "good" | "neutral" | "soft" | "hard";
/** Severity follows the condition, not its fail/info outcome: a busy executor can recover. */
const severity: Record<ReasonCode, ReasonSeverity> = {
  rank_match: "good", no_executor_ranked: "soft", ranked_inputs_ignored: "neutral",
  step_match: "good", capacity_comfortable: "good", capacity_usable: "soft", capacity_unknown: "soft", override: "neutral",
  planner_account: "neutral", runner_disabled: "hard", not_configured: "hard", blocked_by_user: "hard",
  quota_exhausted: "hard", not_installed: "hard", signed_out: "hard", unavailable: "hard", ineligible: "hard",
  runner_unhealthy: "hard", requirements_not_met: "hard", pinned_to_other_model: "neutral",
  executor_busy: "soft", machine_busy: "soft", host_unreachable: "hard", host_reachability_unknown: "soft",
  host_paused: "hard", repo_not_on_host: "hard", needs_new_worktree: "hard", local_grant_required: "hard",
  enforcement_uncertified: "hard", other_exclusion: "soft", step_kind_mismatch: "neutral", step_no_candidates: "soft",
  no_step_matched: "soft", paused: "soft", engine_failed: "hard", override_unavailable: "hard",
  planner_not_measured: "neutral", too_few_samples: "neutral", planner_is_executor: "neutral", cached_preview: "neutral",
  capacity_unmeasured: "soft", default_model_unresolved: "soft", enforcement_unverified: "soft", engine_not_running: "soft",
  learning_unavailable: "neutral", tasks_unavailable: "soft", reserved_capacity: "soft", admission_hooks: "neutral",
};
export function reasonSeverity(code?: string): ReasonSeverity {
  return code && Object.hasOwn(severity, code) ? severity[code as ReasonCode] : "soft";
}
