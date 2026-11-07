import type { Check, Remedy } from "../install/doctor";
import type { SetupChecklist } from "../setup/checklist";
import { checkSetupLink, diagnosticSummary, remedyAgent } from "./diagnostics";

/** Fixed startup gate steps from the setup-health design. */
export type SetupHealthStepId =
  | "service"
  | "detect_agents"
  | "integrations"
  | "usage_eligibility"
  | "ready";

export type SetupHealthStepState =
  | "waiting"
  | "running"
  | "passed"
  | "needs_attention"
  | "failed"
  | "timed_out";

export type SetupHealthTrigger = "startup" | "update" | "manual";
export type SetupHealthOutcome = "ok" | "warnings" | "hard_fail";

/** Primary Fix actions for the gate; consent still happens at apply time. */
export type SetupHealthRepairKind =
  | "agent.reconnect"
  | "limits.refresh"
  | "open.setup"
  | "open.accounts"
  | "open.add_executor"
  | "open.diagnostics";

export interface SetupHealthRepair {
  kind: SetupHealthRepairKind;
  label: string;
  /** Agent id for agent.reconnect (no account fragment). */
  agent?: string;
  /** Shown after file repairs until live enforcement is observed. */
  honesty?: string;
  /** The server's remedy this repair came from, when the doctor sent one. */
  remedy?: Remedy;
}

export interface SetupHealthStep {
  id: SetupHealthStepId;
  title: string;
  state: SetupHealthStepState;
  detail?: string;
}

export interface SetupHealthReport {
  trigger: SetupHealthTrigger;
  eyebrow?: string;
  title: string;
  support: string;
  steps: SetupHealthStep[];
  outcome: SetupHealthOutcome;
  attentionCount: number;
  checkedAt: number;
  durationSeconds?: number;
  repairs?: SetupHealthRepair[];
}

const WIRING_HONESTY = "Wiring OK · live enforcement unverified";

export interface SetupHealthFingerprint {
  schema: 1;
  appVersion: string;
  serviceVersion: string;
  integrationHashes: Record<string, string>;
  attentionCount: number;
  checkedAt: number;
  stepVerdicts: Record<SetupHealthStepId, SetupHealthStepState>;
}

const STEP_TITLES: Record<SetupHealthStepId, string> = {
  service: "Service ready",
  detect_agents: "Detect agents",
  integrations: "Integrations & hooks",
  usage_eligibility: "Usage & eligibility",
  ready: "Ready to take work",
};

const ORDER: SetupHealthStepId[] = [
  "service",
  "detect_agents",
  "integrations",
  "usage_eligibility",
  "ready",
];

function worst(a: SetupHealthStepState, b: SetupHealthStepState): SetupHealthStepState {
  const rank: Record<SetupHealthStepState, number> = {
    failed: 5,
    timed_out: 4,
    needs_attention: 3,
    running: 2,
    waiting: 1,
    passed: 0,
  };
  return rank[a] >= rank[b] ? a : b;
}

function fromLevels(levels: Array<Check["level"]>): SetupHealthStepState {
  if (levels.includes("fail")) return "failed";
  if (levels.includes("warn")) return "needs_attention";
  return "passed";
}

function serviceState(checks: Check[], checklist?: SetupChecklist): SetupHealthStepState {
  const item = checklist?.items.find(i => i.id === "service");
  if (item?.status === "failed") return "failed";
  if (item?.status === "pending") return "needs_attention";
  const service = checks.filter(c => c.name === "Service");
  if (service.length) return fromLevels(service.map(c => c.level));
  return item?.status === "done" ? "passed" : "needs_attention";
}

function detectAgentsState(checks: Check[]): SetupHealthStepState {
  const binaries = checks.filter(c => c.name.startsWith("Binary "));
  if (!binaries.length) return "needs_attention";
  return fromLevels(binaries.map(c => c.level));
}

function integrationsState(checks: Check[]): SetupHealthStepState {
  const names = checks.filter(c =>
    /^(Install|Skill) /.test(c.name) ||
    c.name.startsWith("Integration freshness ") ||
    c.name.startsWith("Claude ") ||
    c.name === "Legacy guard" ||
    c.name.startsWith("Planner check "),
  );
  if (!names.length) return "passed";
  return fromLevels(names.map(c => c.level));
}

function usageState(checks: Check[], checklist?: SetupChecklist): SetupHealthStepState {
  const usage = checks.filter(c => c.name.startsWith("Usage "));
  let state = usage.length ? fromLevels(usage.map(c => c.level)) : "passed";
  const executor = checklist?.items.find(i => i.id === "executor");
  if (executor?.status === "failed") state = worst(state, "failed");
  else if (executor?.status === "pending") state = worst(state, "needs_attention");
  return state;
}

function readyState(parts: SetupHealthStepState[]): SetupHealthStepState {
  if (parts.includes("failed")) return "failed";
  if (parts.some(s => s === "needs_attention" || s === "timed_out")) return "needs_attention";
  return "passed";
}

function outcomeFor(steps: SetupHealthStep[]): SetupHealthOutcome {
  if (steps.some(s => s.state === "failed" && (s.id === "service" || s.id === "ready" || s.id === "integrations"))) {
    if (steps.some(s => s.id === "service" && s.state === "failed")) return "hard_fail";
  }
  if (steps.some(s => s.state === "failed")) return "hard_fail";
  if (steps.some(s => s.state === "needs_attention" || s.state === "timed_out")) return "warnings";
  return "ok";
}

function attentionCount(steps: SetupHealthStep[]): number {
  return steps.filter(s => s.state === "needs_attention" || s.state === "failed" || s.state === "timed_out").length;
}

function detailFor(id: SetupHealthStepId, checks: Check[], checklist?: SetupChecklist): string | undefined {
  if (id === "service") {
    const check = checks.find(c => c.name === "Service");
    if (check) return diagnosticSummary(check);
    return checklist?.items.find(i => i.id === "service")?.detail;
  }
  if (id === "detect_agents") {
    const binaries = checks.filter(c => c.name.startsWith("Binary "));
    const ok = binaries.filter(c => c.level === "ok").length;
    return binaries.length ? `${ok} of ${binaries.length} agent commands found` : undefined;
  }
  if (id === "integrations") {
    const bad = checks.find(c =>
      (c.level === "warn" || c.level === "fail") &&
      (/^(Install|Skill) /.test(c.name) || c.name.startsWith("Claude ") || c.name.startsWith("Integration freshness ")),
    );
    return bad ? diagnosticSummary(bad) : undefined;
  }
  if (id === "usage_eligibility") {
    const usage = checks.find(c => (c.level === "warn" || c.level === "fail") && c.name.startsWith("Usage "));
    if (usage) return diagnosticSummary(usage);
    const executor = checklist?.items.find(i => i.id === "executor");
    if (!executor?.detail) return executor?.detail;
    // Checklist executor detail is already product copy when present.
    return /[#/=]|installed:|running:/.test(executor.detail) ? undefined : executor.detail;
  }
  return undefined;
}

/** The gate action for a server remedy; consent still happens at apply time. */
function remedyRepair(check: Check, remedy: Remedy): SetupHealthRepair {
  const agent = remedyAgent(check);
  if (agent) return { kind: "agent.reconnect", label: "Fix integration", agent, honesty: WIRING_HONESTY, remedy };
  if (remedy.op === "limits.refresh") return { kind: "limits.refresh", label: remedy.label, remedy };
  if (remedy.op === "service.install" && remedy.kind !== "internal") return { kind: "open.setup", label: "Open Setup", remedy };
  if (remedy.kind === "user" && ["account.signin", "runner.block"].includes(remedy.op ?? remedy.secondary?.op ?? ""))
    return { kind: "open.accounts", label: "Review accounts", remedy };
  // Agent tasks, pacer-internal failures and system settings are handled from Diagnostics.
  return { kind: "open.diagnostics", label: "Open Diagnostics", remedy };
}

function linkRepair(link: { href: string } | undefined): SetupHealthRepair | undefined {
  const href = link?.href;
  if (href === "#/setup") return { kind: "open.setup", label: "Open Setup" };
  if (href === "#/settings/add-executor") return { kind: "open.add_executor", label: "Open executor setup" };
  if (href === "#/settings/accounts") return { kind: "open.accounts", label: "Review accounts" };
}

/**
 * Map attention checks to primary Fix descriptors. Never applies changes;
 * agent.reconnect still goes through agent.preview + consent on connect.
 * Only this service's own doctor result reaches the gate, and it gives every warning or failure a remedy,
 * so a check's remedy alone decides its repair. Check names only supply a setup link for remedies the gate
 * cannot run yet.
 */
export function setupHealthRepairs(checks: Check[]): SetupHealthRepair[] {
  const repairs: SetupHealthRepair[] = [];
  const seen = new Set<string>();
  const add = (repair: SetupHealthRepair) => {
    const key = `${repair.kind}:${repair.agent ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    repairs.push(repair);
  };

  for (const check of checks) {
    if ((check.level !== "warn" && check.level !== "fail") || !check.remedy) continue;
    const repair = remedyRepair(check, check.remedy);
    // Agent tasks and pacer restarts have no gate action yet; keep the setup link the check name gave.
    const link = repair.kind === "open.diagnostics" ? linkRepair(checkSetupLink(check)) : undefined;
    add(link ? { ...link, remedy: check.remedy } : repair);
  }

  if (checks.some(c => c.level === "warn" || c.level === "fail") && repairs.length === 0) {
    add({ kind: "open.diagnostics", label: "Open Diagnostics" });
  }
  return repairs;
}

/** Pure aggregation of doctor + checklist into the startup gate steps. */
export function aggregateSetupHealth(input: {
  checks: Check[];
  checklist?: SetupChecklist;
  trigger: SetupHealthTrigger;
  checkedAt: number;
  durationSeconds?: number;
  timedOutSteps?: SetupHealthStepId[];
}): SetupHealthReport {
  const timed = new Set(input.timedOutSteps ?? []);
  const service = serviceState(input.checks, input.checklist);
  const detect = detectAgentsState(input.checks);
  const integrations = integrationsState(input.checks);
  const usage = usageState(input.checks, input.checklist);
  const base: Record<SetupHealthStepId, SetupHealthStepState> = {
    service,
    detect_agents: detect,
    integrations,
    usage_eligibility: usage,
    ready: readyState([service, detect, integrations, usage]),
  };
  for (const id of timed) {
    if (id !== "ready") base[id] = "needs_attention";
  }
  base.ready = readyState(ORDER.filter(id => id !== "ready").map(id => base[id]));

  const steps: SetupHealthStep[] = ORDER.map(id => ({
    id,
    title: STEP_TITLES[id],
    state: base[id],
    detail: timed.has(id)
      ? "This check timed out; review setup when you can."
      : detailFor(id, input.checks, input.checklist),
  }));

  const repairs = setupHealthRepairs(input.checks);

  return {
    trigger: input.trigger,
    ...(input.trigger === "update" ? { eyebrow: "After update · checking setup" } : {}),
    title: "Checking setup",
    support: "Making sure agents can work through pacer.",
    steps,
    outcome: outcomeFor(steps),
    attentionCount: attentionCount(steps),
    checkedAt: input.checkedAt,
    ...(input.durationSeconds != null ? { durationSeconds: input.durationSeconds } : {}),
    ...(repairs.length ? { repairs } : {}),
  };
}

/** Build a fingerprint from a completed report plus version/hash inputs. */
export function fingerprintFromReport(
  report: SetupHealthReport,
  versions: { appVersion: string; serviceVersion: string; integrationHashes: Record<string, string> },
): SetupHealthFingerprint {
  return {
    schema: 1,
    appVersion: versions.appVersion,
    serviceVersion: versions.serviceVersion,
    integrationHashes: { ...versions.integrationHashes },
    attentionCount: report.attentionCount,
    checkedAt: report.checkedAt,
    stepVerdicts: Object.fromEntries(report.steps.map(s => [s.id, s.state])) as Record<SetupHealthStepId, SetupHealthStepState>,
  };
}

/**
 * Skip the full-window stage only when a fresh last pass matches current versions
 * and integration hashes and left zero attention.
 */
export function shouldSkipFullWindow(
  last: SetupHealthFingerprint | null,
  current: { appVersion: string; serviceVersion: string; integrationHashes: Record<string, string> },
): boolean {
  if (!last || last.schema !== 1) return false;
  if (last.attentionCount !== 0) return false;
  if (last.appVersion !== current.appVersion || last.serviceVersion !== current.serviceVersion) return false;
  const keys = new Set([...Object.keys(last.integrationHashes), ...Object.keys(current.integrationHashes)]);
  for (const key of keys) {
    if ((last.integrationHashes[key] ?? "") !== (current.integrationHashes[key] ?? "")) return false;
  }
  return true;
}
