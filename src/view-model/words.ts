import { agentInfo, agentKey } from "./agents";
/** The one vocabulary for statuses, verdicts, phases and modes. Every surface imports these; none spells a status on its own. */
export type StatusTone = "good" | "warn" | "bad" | "info" | "neutral";
export type Tone = StatusTone;

// Legacy wire/display helpers remain stable for protocol compatibility. App status rendering uses the descriptors below.
const tones: Record<string, StatusTone> = {
  good: "good", info: "info", warn: "warn", bad: "bad", muted: "neutral",
  EXHAUSTED: "bad", AHEAD: "warn", NEAR_LIMIT: "warn", EXPIRING: "warn", EXPIRING_SOON: "warn",
  OK: "good", ON_PACE: "good", BEHIND: "good", UNMETERED: "good",
  behind: "good", on_pace: "good", ahead: "warn", out: "bad",
};
/** Maps a tone or verdict string the service wrote to a status tone; the UI never derives one from numbers. */
export const toneFor = (value: string): StatusTone => Object.hasOwn(tones, value) ? tones[value]! : "neutral";

const verdicts: Record<string, string> = {
  ON_PACE: "Available", OK: "Available", UNMETERED: "Available", AHEAD: "Ahead of pace", BEHIND: "Behind pace", EXPIRING: "Expiring soon", EXPIRING_SOON: "Expiring soon", NEAR_LIMIT: "Near limit", EXHAUSTED: "Out of quota",
  behind: "Behind pace", on_pace: "On pace", ahead: "Ahead of pace", out: "Out of quota", unknown: "Usage unknown",
};
export const verdictWords = (v: string): string => Object.hasOwn(verdicts, v) ? verdicts[v]! : "Unknown";

const phases: Record<string, string> = { driving: "You're driving", starting: "Starting", working: "Editing", testing: "Testing", idle: "Idle", "lost-contact": "Lost contact", queued: "Queued" };
export const phaseWords = (phase: string): string => Object.hasOwn(phases, phase) ? phases[phase]! : phase;
export const modeWords = (mode: string): string => mode ? mode[0]!.toUpperCase() + mode.slice(1).toLowerCase() : mode;

/** The fields of an account that labels need; the app's richer Account type satisfies it. */
export interface AccountLike { name: string; runners?: string[]; source?: string; folder?: string; kind?: string; connection?: { base_url_host?: string } }

/** Public labels shared by every screen; account names distinguish endpoints. */
export function executorLabel(id: string | null | undefined, accounts: AccountLike[] = []): string {
  if (!id) return "Automatic";
  const [local, host] = id.split("@");
  const [agent, name] = local!.split("#");
  const account = accounts.find(a => a.runners?.includes(id) || a.name === name);
  const native = agentKey(agent!) ? agentInfo(agent!).name : undefined;
  const defaultAccount = account?.source === "default" || (account?.folder && (
    (agent === "codex" && account.folder.endsWith("/.codex")) ||
    (agent === "claude-code" && account.folder.endsWith("/.claude"))
  ));
  const suffix = name && !defaultAccount ? ` · ${account?.name ?? name}` : "";
  // Known agents and accounts (BytePlus, Local model) get their proper names; a user-named account keeps its name.
  const known = (id: string | undefined) => id && agentKey(id) ? agentInfo(id).name : id;
  const label = agent === "opencode" ? `${known(account?.name ?? name) ?? "OpenCode"}` : `${native ?? known(agent)}${suffix}`;
  return label + (host ? ` on ${host}` : "");
}
/** A known default account uses its agent name; a named account retains its suffix. */
export function accountLabel(account: AccountLike & { agent?: string }): string {
  const runner = account.runners?.[0];
  if (runner) return executorLabel(runner, [account]);
  const agent = account.agent ?? (account.kind === "claude" ? "claude-code" : account.kind === "endpoint" ? "opencode" : account.kind) ?? account.name;
  if (agent === "opencode") return agentInfo(account.name).name;
  const name = agentInfo(agent).name;
  return account.source === "default" || agentKey(account.name) === agentKey(agent) && agentKey(agent) !== null ? name : `${name} · ${account.name}`;
}
export function executorCaption(account?: AccountLike): string {
  if (account?.kind !== "endpoint") return "Agent CLI";
  return account.connection?.base_url_host ? `Model endpoint · ${account.connection.base_url_host}` : "External OpenCode provider";
}
export interface Status { label: string; tone: Tone; glyph: string }
const status = (label: string, tone: Tone, glyph: string): Status => ({ label, tone, glyph });
const unknownStatus = status("Unknown", "neutral", "?");
const taskStates: Record<string, Status> = {
  needs_input: status("Needs your answer", "warn", "!"), running: status("Working", "info", "▶"),
  queued: status("Queued", "neutral", "…"), done: status("Completed", "good", "✓"),
  partial: status("Incomplete", "warn", "!"), failed: status("Failed", "bad", "✕"),
  limit: status("Out of quota", "bad", "!"), stopped: status("Stopped", "neutral", "■"),
};
const sessionStates: Record<string, Status> = {
  driving: status("You're driving", "info", "▶"), starting: status("Starting", "info", "▶"),
  working: status("Editing", "info", "▶"), testing: status("Testing", "info", "▶"),
  idle: status("Idle", "warn", "…"), "lost-contact": status("Lost contact", "bad", "!"),
  queued: taskStates.queued!,
};
const waitingReview = status("Review requested", "warn", "◐");
export interface TaskStatusInput { interactionMode?: import("../tasks/types").InteractionMode; conversation?: import("../tasks/types").ConversationState; dismissed?: boolean; resolved?: string | null; retriedBy?: string | null; state: string; review?: { accepted: boolean } | null; acceptanceState?: string; phase?: string; progress?: { phase?: string } | null }
export function taskStatus(task: TaskStatusInput): Status {
  if (task.interactionMode === "conversation" && task.state === "running") {
    if (task.conversation?.activity === "idle") return status("Ready for input", "neutral", "…");
    if (task.conversation?.activity === "waiting") return status("Needs input", "warn", "?");
    if (task.conversation?.activity === "working") return status("Working", "info", "▶");
  }
  const phase = task.progress?.phase ?? task.phase;
  if (task.state === "running" && phase) return sessionStatus(phase);
  return Object.hasOwn(taskStates, task.state) ? taskStates[task.state]! : unknownStatus;
}
/** Task destinations combine execution, checks and explicit review handoffs. */
export function taskPageStatus(task: TaskStatusInput & {reviewRequest?: unknown; acceptance?: {state:string}}): Status {
  if (task.acceptance?.state === "failed" || task.acceptanceState === "failed") return status("Checks failed", "bad", "✕");
  if (task.review) return taskOutcome(task);
  if (task.reviewRequest && !task.dismissed && !task.resolved && !task.retriedBy) return status("Waiting for review", "info", "◐");
  return taskStatus(task);
}
export function taskOutcome(task: TaskStatusInput): Status {
  return task.review ? task.review.accepted ? status("Accepted", "good", "✓") : status("Rejected", "bad", "✕")
    : status("Outcome not recorded", "neutral", "—");
}
export const sessionStatus = (phase: string): Status => Object.hasOwn(sessionStates, phase) ? sessionStates[phase]! : unknownStatus;
const executorStates: Record<string, Status> = {
  ready: status("Ready", "good", "✓"), busy: status("Busy", "info", "▶"), full: status("At capacity", "info", "■"),
  failing: status("Failing", "warn", "!"), down: status("Unavailable", "bad", "✕"),
  blocked: status("Blocked", "neutral", "■"), exhausted: taskStates.limit!,
  disabled: status("Disabled", "neutral", "■"), checking: status("Checking", "info", "…"),
};
export const executorStatus = (state: string): Status => Object.hasOwn(executorStates, state) ? executorStates[state]! : unknownStatus;
const endpointStates: Record<string, Status> = {
  ready: executorStates.ready!, not_tested: status("Not tested", "neutral", "…"),
  not_working: status("Not working", "bad", "✕"), key_missing: status("Key missing", "bad", "✕"),
  external: status("External provider", "neutral", "■"),
};
/** An executor row's label: a ready but not-tested endpoint reads "Not tested", like its account. */
export function executorRowStatus(row: { state: string; untested?: boolean; recentFailures?: number; lastCheck?: { passed: boolean } | null }): Status {
  if (row.state === "failing" && row.lastCheck?.passed !== false && (row.recentFailures ?? 0) >= 2) {
    return status("Recent task failures", "warn", "!");
  }
  return row.state === "ready" && row.untested ? endpointStates.not_tested! : executorStatus(row.state);
}
export interface AccountStateInput { kind?: string; signedIn?: boolean | null; state?: string | { state?: string } }
/**
 * One readiness label per account. Native accounts show local sign-in; endpoint
 * accounts have keys rather than a sign-in, so they show their endpoint state.
 */
export function accountStatus(account: AccountStateInput): Status {
  const state = typeof account.state === "string" ? account.state : account.state?.state;
  if (account.kind === "endpoint") return state && Object.hasOwn(endpointStates, state) ? endpointStates[state]! : unknownStatus;
  if (state === "no_subscription") return status("No subscription", "neutral", "■");
  if (account.signedIn === true) return status("Signed in", "good", "✓");
  if (account.signedIn === false) return status("Signed out", "bad", "✕");
  return unknownStatus;
}
/** Sign-in help applies only to a native account known to be signed out. */
export const accountNeedsSignIn = (account: AccountStateInput): boolean => account.kind !== "endpoint" && account.signedIn === false;
const paceStates: Record<string, Status> = {
  behind: status("Behind pace", "good", "↓"), on_pace: status("On pace", "good", "✓"),
  ahead: status("Ahead of pace", "warn", "↑"), out: taskStates.limit!,
  UNMETERED: status("Unmetered", "good", "∞"), EXPIRING: status("Expiring soon", "warn", "!"),
  EXPIRING_SOON: status("Expiring soon", "warn", "!"), unknown: status("Usage unknown", "neutral", "?"),
};
const paceAliases: Record<string, string> = {
  BEHIND: "behind", ON_PACE: "on_pace", OK: "on_pace", AHEAD: "ahead", NEAR_LIMIT: "ahead", EXHAUSTED: "out",
};
/** Verdict aliases describe the same pace fact in older provider and newer planner payloads. */
export function paceStatus(verdict: string): Status {
  const canonical = Object.hasOwn(paceAliases, verdict) ? paceAliases[verdict]! : verdict;
  return Object.hasOwn(paceStates, canonical) ? paceStates[canonical]! : paceStates.unknown!;
}
export function attentionStatus(item: { kind: string; taskId?: string }, tasks: (TaskStatusInput & { id: string })[] = []): Status {
  const task = tasks.find(t => t.id === item.taskId);
  if (item.kind === "review") return waitingReview;
  if (item.kind === "failed" && (task?.state === "done" || task?.acceptanceState === "failed")) return status("Checks failed", "bad", "✕");
  if (task) return taskStatus(task);
  return ({ review: waitingReview, question: taskStates.needs_input!, failed: taskStates.failed!, limit: taskStates.limit!,
    executor_down: executorStates.down!, host_down: executorStates.down!, stuck: sessionStates.idle! } as Record<string, Status>)[item.kind] ?? status("Needs attention", "warn", "!");
}

/** Compact status-line vocabulary, shared with integrations. */
export const offlineWords = "pacer not running · pacer serve";
/** The name shown for the machine pacer runs on, wherever a host is named. */
export const localHostWords = "This Mac";
/** Attention raised by a subtask, shown on its collapsed parent so the tint is never the only signal. */
export const subtaskAttentionWords = (label: string): string => `Subtask: ${label}`;
export const compactVerdictWords = (verdict: string): string =>
  verdict === "out" || verdict === "EXHAUSTED" ? "out" : verdict === "ahead" || verdict === "AHEAD" ? "ahead" : "";

/** Human-facing percentages never expose floating-point precision. */
export const percentage = (value: number): string => `${Math.round(value)}%`;
