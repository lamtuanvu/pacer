import type { RepoRef } from "../api/read-model/types";
import type { Progress } from "../supervisor/progress";
import type { WorktreeMode } from "../config/execution";
import type { ResultCheck } from "../classify/hooks";

export type InteractionMode = "delegated" | "conversation";
export type ConversationActivity = "starting" | "working" | "waiting" | "idle" | "ended";
export interface ConversationState {
  activity: ConversationActivity;
  agentSessionId?: string;
  endReason?: "user" | "agent_exit" | "failure";
}

export type TaskState = "queued" | "running" | "done" | "partial" | "failed" | "limit" | "stopped" | "needs_input";
export const TERMINAL_STATES: readonly TaskState[] = ["done", "partial", "failed", "limit", "stopped", "needs_input"];

/** What the planner hands over. `repo` is an absolute path; `acceptance` is a shell command run in it. */
export interface Brief {
  goal: string;
  repo: string;
  scope?: string;
  acceptance?: string;
  constraints?: string;
  context?: string;
  feedback?: string;
  qa?: { q: string; a: string }[];
  base?: string;
  worktreeBase?: "default" | "head";
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

export interface Attempt {
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
  acceptance?: { cmd: string; passed: boolean; tail: string; durationS?: number; summary?: string; machine?: string | null };
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

export interface RunRef {
  interactionMode?: InteractionMode;
  session?: "interactive";
  takeover?: boolean;
  agentSession?: {id: string; source: "header" | "assigned" | "lookup"};
  /** Wrapper-owned clock/PID, bound after the one-use start; distinct from host claim time. */
  wrapperStartedAt?: number;
  wrapperPid?: number;
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
}

export interface ReviewRequest { note: string; at: number }

export interface TaskRecord {
  /** Native conversation identity admission precedes any external create command. */
  nativeIdentityIntent?: { attempt: number; providerId: string; executor: string;
    workdir: string; kind: "assigned" | "create" | "lookup" | "header";
    requestedId?: string; id?: string; source?: "assigned" | "lookup" | "header" };
  /** Host-authorized origin fetch is journaled before effect; unresolved outcomes cannot be retried. */
  baseFetchIntent?: { attempt: number; providerId: string; repoTop: string;
    originHash: string; base?: string; sha?: string };
  /** Exact local attempt directory claimed before creation and cleared with the durable run reference. */
  runClaim?: { attempt: number; providerId: string; executor: string; workdir: string; dir: string;
    session?: "interactive";
    interactionMode?: "conversation"; agentSession?: RunRef["agentSession"];
    host?: string; remoteDir?: string; remoteBranch?: string; baseSha?: string };
  /** A wrapper start may have reached the OS; never authorize a second start for this attempt. */
  startIntent?: { attempt: number; providerId: string; dir: string };
  /** Host-verified exit of the exact provider-owned run, safe across later task revision changes. */
  executorExitReceipt?: { attempt: number; providerId: string; dir: string; startedAt: number; exitCode: number };
  /** Exact terminal interactive report reaped by the host before logical settlement. */
  executorReportReceipt?: { attempt: number; providerId: string; dir: string; startedAt: number;
    status: "done" | "failed"; summary: string; at: number; exitCode: number };
  /** Durable exact placement claimed before an executor-owned Git worktree effect. */
  worktreeIntent?: { attempt: number; providerId: string; repoTop: string; repoMain: string;
    path: string; workdir: string; branch: string; baseSha: string };
  /** PREPARE may have reached SSH; only read-only reconciliation may follow a missing receipt. */
  remotePrepareIntent?: { attempt: number; providerId: string; executor: string; alias: string;
    hostFingerprint: string; repoTop: string; originHash: string; checkout: string; tag: string;
    baseSha: string; base: string; missingBaseReceiptAt?: number; bundleRetryIssuedAt?: number };
  /** Fix the local destination before a remote bundle can publish a branch. */
  remoteTransferIntent?: { attempt: number; providerId: string; dir: string;
    startedAt: number; branch: string; oldHead: string };
  /** Complete fixed preflight proved an exited failed remote attempt has no commits to transfer. */
  remoteTransferNoWork?: { attempt: number; providerId: string; dir: string;
    startedAt: number; exitCode: number };
  /** Persisted owner of a plugin-backed direct attempt, including before its run directory exists. */
  executorProvider?: string;
  /** A stop request is not terminal until the exact executor exit is verified. */
  stopPending?: { attempt: number; requestedAt: number; providerId: string; graceMs: number;
    reason?: "user" | "deadline" };
  sessionDraftId?: string;
  interactionMode?: InteractionMode;
  conversation?: ConversationState;
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
  placement?: TaskPlacement;
  worktree?: string;
  id: string;
  createdAt: number;
  kind: string | null;
  requestedExecutor: string | null;
  /** Set when the requested executor could not run and another one did. */
  executorFallback?: { requested: string; reason: string; executor: string };
  timeoutS: number;
  brief: Brief;
  state: TaskState;
  queue?: { nextAt?: number; reason: "no_slot" | "paused" | "host_down" | "waiting_retry"; detail?: string; since: number; position: number; limit?: "executor" | "machine" | "host"; capacity?: {used: number; max: number} };
  runnerPid?: number;
  executor?: string;
  backend?: string;
  attemptStartedAt?: number;
  dismissed?: boolean;
  retryOf?: string;
  retriedBy?: string;
  force?: boolean;
  fromPanel?: boolean;
  childPid?: number;
  attempts: Attempt[];
  result?: TaskResult;
}

