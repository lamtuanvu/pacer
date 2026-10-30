import { z } from "zod";

/** Every reason code `dispatch.explain` can return. Adding a code is additive (P4, API-1); clients show generic copy for unknown ones. */
export const REASON_CODES = [
  // why an executor was chosen
  "rank_match", "no_executor_ranked", "step_match", "capacity_comfortable", "capacity_usable", "capacity_unknown", "override",
  // why an executor was left out
  "planner_account", "runner_disabled", "not_configured", "blocked_by_user", "quota_exhausted", "not_installed", "signed_out",
  "unavailable", "ineligible", "runner_unhealthy", "requirements_not_met", "pinned_to_other_model",
  "executor_busy", "machine_busy", "host_unreachable", "host_reachability_unknown", "host_paused", "repo_not_on_host",
  "needs_new_worktree", "local_grant_required", "enforcement_uncertified", "other_exclusion",
  // outcomes with no chosen executor
  "step_kind_mismatch", "step_no_candidates", "no_step_matched", "paused", "engine_failed", "override_unavailable",
  // planner cost
  "planner_not_measured", "too_few_samples", "planner_is_executor",
  // facts that could change the outcome
  "cached_preview", "capacity_unmeasured", "default_model_unresolved", "enforcement_unverified", "engine_not_running",
  "learning_unavailable", "tasks_unavailable", "reserved_capacity", "admission_hooks", "ranked_inputs_ignored",
  "classifier_unavailable",
] as const;
export const reasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof reasonCodeSchema>;
export type ReasonFacts = Record<string, string | number | boolean | null>;
export interface Reason { code: ReasonCode; outcome: "pass" | "fail" | "info"; subject?: string; facts: ReasonFacts; text: string }

const num = (v: unknown) => (typeof v === "number" ? String(Math.round(v)) : "?");
const TEXT: Record<ReasonCode, (f: ReasonFacts, s?: string) => string> = {
  rank_match: f => `Executor ranking selected this executor (${f.reason}).`,
  no_executor_ranked: () => "No executor is available in the routing rank.",
  step_match: f => `Ladder step "${f.stepId}" matched${f.kind ? ` for kind "${f.kind}"` : ""}.`,
  capacity_comfortable: f => `${num(f.headroomPct)}% of its budget window is free, enough to run comfortably.`,
  capacity_usable: f => `${num(f.headroomPct)}% of its budget window is free; usable, not comfortable.`,
  capacity_unknown: () => "Its remaining capacity is not measured.",
  override: f => `You asked for ${f.executor} for this task only.`,
  planner_account: () => "It shares the planner's account and is kept for planning.",
  runner_disabled: () => "It is switched off.",
  not_configured: () => "It is not fully set up.",
  blocked_by_user: () => "You blocked it.",
  quota_exhausted: f => (f.resetsAt ? `Its budget is used up until ${f.resetsAt}.` : "Its budget is used up."),
  not_installed: () => "Its command-line tool is not installed.",
  signed_out: () => "It is signed out.",
  unavailable: () => "It is not available right now.",
  ineligible: () => "It cannot take work right now.",
  runner_unhealthy: () => "It reported itself unhealthy.",
  requirements_not_met: () => "It does not meet the task's requirements.",
  pinned_to_other_model: () => "The task is pinned to a different model.",
  executor_busy: f => `${f.of} is busy (${num(f.used)}/${num(f.limit)} running).`,
  machine_busy: f => `This machine is busy (${num(f.used)}/${num(f.limit)} running).`,
  host_unreachable: f => `Host ${f.host} is unreachable.`,
  host_reachability_unknown: f => `Host ${f.host} has not been checked recently.`,
  host_paused: f => `Host ${f.host} is paused.`,
  repo_not_on_host: f => `The repository is not set up on host ${f.host}.`,
  needs_new_worktree: () => "Remote runners need a new worktree.",
  local_grant_required: () => "Scoped child delegation needs a local executor.",
  enforcement_uncertified: f => `Its native delegation control is not verified${f.agent ? ` for ${f.agent}` : ""}.`,
  other_exclusion: (_f, s) => s ?? "It is not available right now.",
  step_kind_mismatch: () => "The step is for a different kind of task.",
  step_no_candidates: () => "No executor qualified for this step.",
  no_step_matched: () => "No ladder step has a qualifying executor.",
  paused: f => (f.until ? `Dispatch is paused until ${f.until}.` : "Dispatch is paused."),
  engine_failed: f => `The decision engine returned ${f.validation}; nothing was chosen.`,
  override_unavailable: f => `${f.requested} cannot take the task (${f.reason}); the ladder's pick is used instead.`,
  planner_not_measured: () => "Planner tokens are not measured yet.",
  too_few_samples: f => `${num(f.samples)} comparable reviewed tasks; ${num(f.needed)} needed for an estimate.`,
  planner_is_executor: () => "The planner's account is also the chosen executor.",
  cached_preview: () => "This reads cached observations and reserves nothing; the real dispatch may differ.",
  capacity_unmeasured: () => "Remaining capacity is unknown for this executor.",
  default_model_unresolved: () => "The executor's default model is not resolved.",
  enforcement_unverified: f => `Native delegation control has not been checked in this process${f.agent ? ` for ${f.agent}` : ""}.`,
  engine_not_running: f => `The decision engine ${f.engine} is not running; the ladder was used.`,
  learning_unavailable: () => "Learned fit was skipped because no history store exists yet.",
  tasks_unavailable: () => "Running tasks could not be read; none were counted.",
  reserved_capacity: () => "Capacity reserved by running work may change this at admission.",
  ranked_inputs_ignored: f => `Executor ranking ignores these dispatch inputs: ${f.fields}.`,
  admission_hooks: () => "Configured admission hooks are not run by this preview.",
  classifier_unavailable: f => `The classifier plugin did not answer (${f.error}), so the task kind is unknown.`,
};

export function reason(code: ReasonCode, outcome: Reason["outcome"], facts: ReasonFacts = {}, subject?: string, text?: string): Reason {
  return { code, outcome, ...(subject !== undefined ? { subject } : {}), facts, text: text ?? TEXT[code](facts, text) };
}

/** Map the free-text exclusion strings produced by ranking, slots, remote and candidate checks to codes. Unknown text becomes `other_exclusion` with the text kept. */
export function exclusionReason(subject: string, text: string, eligibility?: { state: string; reasons?: readonly { code: string }[] }): Reason {
  const make = (code: ReasonCode, facts: ReasonFacts = {}) => reason(code, "fail", facts, subject);
  const fixed: Record<string, ReasonCode> = {
    planner: "planner_account", disabled: "runner_disabled", "not configured": "not_configured", "Blocked by you": "blocked_by_user",
    exhausted: "quota_exhausted", "not installed": "not_installed", "Quota exhausted": "quota_exhausted",
    "Runner unavailable or disabled": "runner_disabled", "Runner not healthy": "runner_unhealthy",
    "Task requirements not satisfied": "requirements_not_met", "Different pinned model": "pinned_to_other_model",
    "remote runners need a new worktree": "needs_new_worktree", "scoped child delegation requires local grant transport": "local_grant_required",
  };
  if (fixed[text]) return make(fixed[text]);
  if (eligibility?.state === "ineligible") {
    if (eligibility.reasons?.some(r => r.code === "budget_exhausted")) return reason("quota_exhausted", "fail", {}, subject, text);
    return reason("ineligible", "fail", {}, subject, text);
  }
  let m: RegExpExecArray | null;
  if ((m = /^host (.+) reachability unknown/.exec(text))) return make("host_reachability_unknown", { host: m[1] });
  if ((m = /^host (.+) unreachable$/.exec(text))) return make("host_unreachable", { host: m[1] });
  if ((m = /^(.+) paused$/.exec(text))) return make("host_paused", { host: m[1] });
  if ((m = /^repo not set up on (\S+)/.exec(text))) return make("repo_not_on_host", { host: m[1] });
  if ((m = /^this machine busy \((\d+)\/(\d+)\)$/.exec(text))) return make("machine_busy", { used: +m[1], limit: +m[2] });
  if ((m = /^(.+) busy \((\d+)\/(\d+)\)$/.exec(text))) return make("executor_busy", { used: +m[2], limit: +m[3], of: m[1] });
  if (/native|Could not verify|No native control adapter|Executor account is unavailable/i.test(text)) return make("enforcement_uncertified");
  if (/^Not working/.test(text)) return make("unavailable");
  return reason("other_exclusion", "fail", {}, subject, text);
}
