/** App copy for dispatch reason codes. Service prose and opaque exclusions never reach the UI. */
import { clock } from "./time";
import { executorLabel } from "./words";

export interface RouteReason {
  code: string;
  facts: Record<string, string | number | boolean | null>;
  subject?: string;
}

type Copy = (time: (key: string) => string | null, fact: (key: string) => string | number | boolean | null | undefined) => string;
const COPY: Record<string, Copy> = {
  executor_busy: (_t, fact) => `is busy${typeof fact("used") === "number" && typeof fact("limit") === "number" ? ` (${fact("used")} of ${fact("limit")} running)` : " with other work"}.`,
  machine_busy: () => "is waiting for space on this machine.",
  quota_exhausted: time => `has used its budget${time("resetsAt") ? ` until ${time("resetsAt")}` : ""}.`,
  runner_disabled: () => "is switched off.",
  blocked_by_user: () => "is blocked by you.",
  signed_out: () => "is signed out.",
  not_installed: () => "needs its command-line tool installed.",
  not_configured: () => "needs to be set up.",
  unavailable: () => "is not available right now.",
  ineligible: () => "cannot take new work right now.",
  runner_unhealthy: () => "is not working properly.",
  requirements_not_met: () => "does not meet this task’s requirements.",
  host_unreachable: () => "cannot be reached on its host.",
  host_reachability_unknown: () => "has not had its host checked recently.",
  host_paused: () => "is on a paused host.",
  repo_not_on_host: () => "needs this repository set up on its host.",
  enforcement_uncertified: () => "needs its delegation controls verified.",
};
/** Reasons about the dispatcher as a whole; they name no executor. */
const GLOBAL: Record<string, Copy> = {
  paused: time => `Dispatch is paused${time("until") ? ` until ${time("until")}` : ""}.`,
  no_step_matched: () => "No agent qualifies for any step of the strategy.",
  step_no_candidates: () => "No agent qualifies for this step of the strategy.",
  engine_failed: () => "The decision engine failed, so nothing was chosen.",
};

/** Unknown and opaque reasons ignore the subject too: it may contain free-text service copy. */
export function routeReasonCopy(reason: RouteReason, now: number, runner?: string): string {
  const fact = (key: string) => reason.facts[key];
  const time = (key: string) => {
    const value = reason.facts[key];
    return typeof value === "number" && Number.isFinite(value) ? clock(value, now) : null;
  };
  if (Object.hasOwn(GLOBAL, reason.code)) return GLOBAL[reason.code]!(time, fact);
  const copy = Object.hasOwn(COPY, reason.code) ? COPY[reason.code] : undefined;
  const name = executorLabel((copy ? reason.subject : undefined) ?? runner ?? "Executor");
  return `${name} ${copy ? copy(time, fact) : "is not available right now."}`;
}
