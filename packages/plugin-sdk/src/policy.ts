/** Protocol 1.6 contracts used by the negotiated TypeScript observation runtime. */
export const POLICY_OBSERVATIONS_FEATURE = "policyObservations";
export type PolicyDecision = "delegate" | "route" | "review";
export type PolicyVerdict =
  | { verdict: "allow" | "veto"; reason?: string }
  | {
      verdict: "amend";
      reason?: string;
      amend:
        | {
            kind?: string | null;
            requestedExecutor?: string | null;
            placement?: "current" | "new" | "auto";
          }
        | { exclude: string[] };
    };
export type PolicyEventType =
  | "desktop.update"
  | "plugin"
  | "pause"
  | "task"
  | "mode"
  | "config"
  | "reset"
  | "planner"
  | "executor"
  | "account"
  | "host"
  | "repo"
  | "counts"
  | "attention"
  | "activity"
  | "job"
  | "notify";
export type PolicyTaskState =
  | "queued"
  | "running"
  | "done"
  | "partial"
  | "failed"
  | "limit"
  | "stopped"
  | "needs_input";
export interface PolicyTask {
  id: string;
  state: PolicyTaskState;
  [key: string]: unknown;
}
export interface PolicyEvent {
  seq: number;
  at: number;
  type: PolicyEventType;
  data: unknown;
}
export interface ObservationClient {
  tasks: {
    read(id: string): Promise<PolicyTask>;
    list(options?: {
      states?: PolicyTaskState[];
      limit?: number;
    }): Promise<PolicyTask[]>;
  };
  events: { subscribe(types: PolicyEventType[]): Promise<void> };
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): Promise<void>;
  config(): Promise<Record<string, unknown>>;
}

export type PolicyBeforeParams =
  | {
      decision: "delegate";
      input: {
        goal: string;
        repo: string;
        kind: string | null;
        requestedExecutor: string | null;
        placement: "current" | "new" | "auto";
      };
    }
  | { decision: "route"; input: { taskId: string; candidates: string[] } }
  | {
      decision: "review";
      input: {
        taskId: string;
        revision: number;
        state: PolicyTaskState;
        verdict: "accept" | "reject" | "send_back" | "retry";
        note?: string;
        kind?: string | null;
        executor?: string;
      };
    };
