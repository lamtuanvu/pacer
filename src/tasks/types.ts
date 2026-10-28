import type { RepoRef } from "../api/read-model/types";
import type { Progress } from "../supervisor/progress";
import type { WorktreeMode } from "../config/execution";
import type { ResultCheck } from "../classify/hooks";
import type { ProcessIdentity } from "../update/desktop/process-identity";

export type InteractionMode = "delegated" | "conversation";
export type ConversationActivity = "starting" | "working" | "waiting" | "idle" | "ended";
export interface ConversationState {
  activity: ConversationActivity;
  agentSessionId?: string;
  endReason?: "user" | "agent_exit" | "failure";
}

/** no_slot: a hard parallel-task cap is full. machine_*: a local machine guard holds new starts. */
export const QUEUE_REASONS = ["no_slot", "paused", "host_down", "waiting_retry", "machine_memory_pressure", "machine_load"] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];
/** What the machine guard observed at the last scheduling check. */
export interface MachineWait { memoryPressure?: "normal" | "warning" | "critical"; memoryPressureLimit?: "warning" | "critical"; loadPerCore?: number; loadLimit?: number }

export type TaskState = "queued" | "running" | "done" | "partial" | "failed" | "limit" | "stopped" | "needs_input";
export const TERMINAL_STATES: readonly TaskState[] = ["done", "partial", "failed", "limit", "stopped", "needs_input"];

/** What the planner hands over. `repo` is an absolute path; `acceptance` is a shell command run in it. */
export interface Brief {
  goal: string;
  repo: string;
  scope?: string;
  acceptance?: string;
  /** Acceptance deadline in minutes (integer 1–120); omitted means 10. */
  acceptanceTimeoutMin?: number;
  constraints?: string;
  context?: string;
  feedback?: string;
  qa?: { q: string; a: string }[];
  base?: string;
  worktreeBase?: "default" | "head";
  /** Run the acceptance command with `set -o pipefail`. Off by default: the command runs exactly as written. */
  pipefail?: boolean;
}

export interface RoutingNote {
  eligibility?: import("../evidence/types").EligibilityDecision;
  fallback?: "uncertain";
  policy?: { source: "project"; repoKey: string; rev: number; executors: string[] };
  kind: string | null;
  kindSource: "brief" | "classifier";
  rule: string;
  chosen: string;
  why: string;
  skipped: { executor: string; reason: string }[];
}

export interface AttemptUsage {
  account: string;
  usedPct: number | null;
  window: string | null;
  at: number;
  poolId?: string | null;
  resetEpoch?: number | null;
  capturedAt?: number | null;
  observationId?: string | null;
  stale?: boolean;
}

export type TokenCoverage = "measured" | "partial" | "unknown";

/**
 * Token usage of one attempt. `null` means "not reported", never zero. `total` is the provider's own
 * total, or input + output when the provider splits them; cache reads and writes stay out of it.
 */
export interface AttemptTokens {
  coverage: TokenCoverage;
  /** Fresh input tokens, excluding cached reads. */
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Including reasoning tokens. */
  output: number | null;
  /** Subset of `output`, where reported. */
  reasoning: number | null;
  total: number | null;
  /** Model requests made during the attempt, where reported. */
  turns: number | null;
  source: "executor-json" | "executor-text" | "endpoint-response" | "adapter";
  /** True when stdout that repository code could also write was the source. */
  selfReported: boolean;
  /** Extractor id and version, e.g. "claude-stream-json@1". */
  extractor: string;
  capturedAt: number;
  /** Why coverage is partial or unknown. */
  note?: string;
}

export interface Attempt {
  tokens?: AttemptTokens;
  routing?: RoutingNote;
  usageAtStart?: AttemptUsage;
  usageAtEnd?: AttemptUsage;
  executor: string;
  model: string | null;
  actualModel?: string | null;
  dispatchSettingsHash?: string;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  timedOut: boolean;
  limitHit: boolean;
  log: string;
  brokenReason?: string;
}

export interface Verification {
  files: string;
  /** `exitCode` and `shell` are always set by `verifyRepo`; optional so hand-built results (tests, other callers) need not supply them. */
  acceptance?: {
    cmd: string; passed: boolean; tail: string; durationS?: number; summary?: string; machine?: string | null;
    exitCode?: number; shell?: string; hint?: string; timedOut?: boolean;
  };
}

export interface TaskResult extends Verification {
  status: Exclude<TaskState, "queued" | "running">;
  executor: string | null;
  model: string | null;
  report: string;
  backend: string;
  worktree?: string;
  brokenExecutor?: string;
  brokenReason?: string;
  check?: ResultCheck;
}

export type WorktreeRequest = "current" | "new" | "auto";
export interface ResolvedPlacement { mode: "current" | "new"; why: string }
export interface TaskPlacement extends Partial<ResolvedPlacement> { requested: WorktreeRequest; reason?: string }

/** Pure placement choice; callers veto explicit current when the worktree is busy. The uncommitted-work hint only counts when the worktree is actually dirty. */
export function resolvePlacement(task: Pick<TaskRecord,"kind"|"brief"|"placement">, strategy: WorktreeMode, busy: boolean, dirty = false): ResolvedPlacement {
  const requested=task.placement?.requested;
  if(requested==="current"||requested==="new")return {mode:requested,why:`agent: ${task.placement?.reason?.trim() || "no reason given"}`};
  if(busy)return {mode:"new",why:"another task is writing there"};
  if(task.kind==="research")return {mode:"current",why:"read-only kind"};
  if(dirty&&/uncommitted|in[ -]progress|working[ -]tree|unstaged/i.test([task.brief.goal,task.brief.context,task.brief.scope].join("\n")))return {mode:"current",why:"builds on uncommitted work"};
  return {mode:strategy==="current"?"current":"new",why:"strategy default"};
}

/** Commit a running task's changes are counted from: the new worktree's base, or the in-place start commit. */
export function progressBase(t: Pick<TaskRecord, "run" | "baseSha" | "baseBranch" | "startSha">): string | null {
  return t.run?.mode === "new" ? t.baseSha ?? t.baseBranch ?? null : t.run?.mode === "current" ? t.startSha ?? null : null;
}

export interface RunnerHandover {
  protocol: number;
  pacer: string;
  identity: ProcessIdentity;
  state?: "handed-over";
  committedAt?: number;
  signalledAt?: number;
  declinedAt?: number;
  replacementAt?: number;
}

export interface RunRef {
  interactionMode?: InteractionMode;
  takeover?: boolean;
  agentSession?: {id: string; source: "header" | "assigned" | "lookup"};
  host?: string;
  remoteDir?: string;
  remoteWorktree?: string;
  remoteBranch?: string;
  transferredHead?: string;
  baseSha?: string;
  dir: string;
  attempt: number;
  executor: string;
  startedAt: number;
  mode: "current" | "new";
  workdir: string;
  logFile: string;
  lastMessageFile?: string;
  waitKey?: string;
  idleAlertedAt?: number;
}

export interface ReviewRequest { note: string; at: number }

/**
 * A worker an interactive lane's backend owns and can reach live: `task.send` delivers into it, an answer reattaches to it,
 * and it holds its executor's slot while the task waits in `needs_input`. `task.stop`, expiry and settlement release it.
 */
export interface LiveWorker {
  /** The backend that owns the worker; only it can send into or release it. */
  backend: string;
  worker: string;
  terminal: string;
  executor: string;
  /** The agent the backend expects in the terminal's foreground; input is refused when anything else is there. */
  agent: string;
  incarnation?: string;
  /** When the worker last became idle-owned (started, escalated or reattached), for the idle expiry. */
  since: number;
}

export interface TaskRecord {
  sessionDraftId?: string;
  interactionMode?: InteractionMode;
  conversation?: ConversationState;
  /** `pacer delegate --interactive`: a conversation that may run on any backend and keep its worker live. A chat from `session.create` stays on the direct backend, whose terminal `session.io` streams. */
  interactive?: boolean;
  /** Lanes sharing a named Orca parent worktree (`pacer delegate --group`); cosmetic grouping when the backend isn't Orca. */
  group?: string;
  /** Who most recently delivered live input into this task's running terminal (`pacer send`); a short lease, not a process lock. */
  driving?: { by: string; at: number };
  /** The interactive lane's worker the backend keeps owning, while running and after a `needs_input` escalation. */
  live?: LiveWorker;
  reviewRequest?: ReviewRequest;
  settledAt?: number;
  archived?: boolean;
  archivePath?: string;
  title?: string;
  source?: "planner" | "ui" | "cli" | "onboarding";
  requestId?: string;
  repo?: RepoRef;
  client?: string;
  /** Checkpoint for the in-flight attempt, retained when its runner resumes. */
  pendingAttempt?: Pick<Attempt, "routing" | "usageAtStart">;
  rev: number;
  question?: { text: string; at: number; answer?: string; answeredAt?: number };
  run?: RunRef;
  takeover?: {state: "starting" | "driving" | "ended"; at: number; sessionId: string; by?: string};
  progress?: Progress;
  resumeSpawnedAt?: number;
  review?: {accepted:boolean; kind:string|null; note:string|null; at:number};
  resolved?: string;
  resolutionCheckedAt?: number;
  baseBranch?: string;
  baseSha?: string;
  /** HEAD when the first local in-place attempt started; live progress counts from it. */
  startSha?: string;
  placement?: TaskPlacement;
  worktree?: string;
  /** Set when pacer removed this lane's unused worktree and cleared its recorded path; an answer then starts from `baseSha`. */
  worktreeReleased?: { at: number; path: string };
  /** The machine id of the pacer home that created the task, once it has an identity. */
  machineId?: string;
  id: string;
  createdAt: number;
  kind: string | null;
  requestedExecutor: string | null;
  /** Set when the requested executor could not run and another one did. */
  executorFallback?: { requested: string; reason: string; executor: string };
  timeoutS: number;
  brief: Brief;
  state: TaskState;
  queue?: { nextAt?: number; reason: QueueReason; detail?: string; since: number; position: number; limit?: "executor" | "machine" | "host"; capacity?: {used: number; max: number}; machine?: MachineWait };
  runnerPid?: number;
  handover?: RunnerHandover;
  runnerPacer?: string;
  childIdentity?: ProcessIdentity;
  executor?: string;
  backend?: string;
  attemptStartedAt?: number;
  dismissed?: boolean;
  /** Participant that started this task when it has no work parent: "human" or "external:<key>". */
  origin?: string;
  /** Set while a message turn is queued or running; cleared when the run ends. */
  pendingTurn?: { id: string; executor: string; at: number };
  /** Closed for messaging by its parent; no more turns. */
  msgClosed?: boolean;
  /** Per-tree guardrail override given at delegate time; read from the tree's root task. */
  messaging?: import("../messaging/types").MessagingOverride;
  retryOf?: string;
  retriedBy?: string;
  force?: boolean;
  fromPanel?: boolean;
  childPid?: number;
  attempts: Attempt[];
  result?: TaskResult;
}

