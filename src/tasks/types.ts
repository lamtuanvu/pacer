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

export interface Attempt {
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
  acceptance?: { cmd: string; passed: boolean; tail: string };
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

export interface TaskRecord {
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

