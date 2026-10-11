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
  backend: "direct";
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
  childPid?: number;
  attempts: Attempt[];
  result?: TaskResult;
}
