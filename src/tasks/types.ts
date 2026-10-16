import type { RepoRef } from "../api/read-model/types";
import type { Progress } from "../supervisor/progress";
import type { WorktreeMode } from "../config/execution";
import type { ResultCheck } from "../classify/hooks";

export type TaskState = "queued" | "running" | "done" | "partial" | "failed" | "limit" | "stopped";
export const TERMINAL_STATES: readonly TaskState[] = ["done", "partial", "failed", "limit", "stopped"];

/** What the planner hands over. `repo` is an absolute path; `acceptance` is a shell command run in it. */
export interface Brief {
  goal: string;
  repo: string;
  scope?: string;
  acceptance?: string;
  constraints?: string;
  context?: string;
}

export interface RoutingNote {
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
}

export interface Attempt {
  routing?: RoutingNote;
  usageAtStart?: AttemptUsage;
  usageAtEnd?: AttemptUsage;
  executor: string;
  model: string | null;
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

export interface TaskRecord {
  repo?: RepoRef;
  client?: string;
  /** Checkpoint for the in-flight attempt, retained when its runner resumes. */
  pendingAttempt?: Pick<Attempt, "routing" | "usageAtStart">;
  rev: number;
  run?: RunRef;
  progress?: Progress;
  resumeSpawnedAt?: number;
  review?: {accepted:boolean; kind:string|null; note:string|null; at:number};
  resolved?: string;
  resolutionCheckedAt?: number;
  baseBranch?: string;
  placement?: TaskPlacement;
  worktree?: string;
  id: string;
  createdAt: number;
  kind: string | null;
  requestedExecutor: string | null;
  timeoutS: number;
  brief: Brief;
  state: TaskState;
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

