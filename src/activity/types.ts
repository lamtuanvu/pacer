export const ACTIVITY_KINDS = ["plugin_state", "task_started", "task_settled", "verdict", "retry", "mode", "budget_refreshed", "executor_state", "host_state", "account_state", "config", "update"] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];
