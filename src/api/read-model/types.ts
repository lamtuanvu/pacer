import type { TaskRecord } from "../../tasks/types";
import type { AttentionItem } from "../../attention/types";
export type { AttentionItem, Action } from "../../attention/types";
export type { ActivityEntry } from "../../activity/log";
import type { LinkSnapshot, TaskData } from "../../link/envelope";

export interface RepoRef { key: string; label: string; path: string; unreachable?: true; identityUnverified?: true }
/** fullTitle is complete display text; title remains the compact compatibility fallback. */
export type TaskDataV2 = TaskData & { archived?: boolean; archivePath?: string; title: string; fullTitle?: string; question?: TaskRecord["question"]; rev: number; queue: TaskRecord["queue"] | null; repo: RepoRef; kind: string | null; host: string | null; source?: TaskRecord["source"] };
export type ApiTask = TaskDataV2;
export interface ExecutorRow {
 stale?: boolean;
 eligibility?: import("../../evidence/types").EligibilityDecision;
 id: string; agent: string; account: string; host: string | null; model: string | null;
 rank: number | "planner"; enabled: boolean;
 state: "ready" | "busy" | "full" | "failing" | "down" | "blocked" | "exhausted" | "disabled" | "checking";
 /** Ready to route, but a managed endpoint whose test task has not run yet. Shown as "Not tested". */
 untested?: true;
 tone: "good" | "info" | "warn" | "bad" | "muted";
 sub: string; reason?: string; usedPct: number | null; pacePct: number | null; paceReason?: string;
 limitedBy?: "machine" | "host";
 slots: { used: number; max: number }; lastCheck: { at: number; passed: boolean; detail?: string } | null;
 recentFailures: number; next: boolean;
}
export interface AccountSummary {
 stale?: boolean; capturedAt?: number | null;
 eligibility?: import("../../evidence/types").EligibilityDecision;
 name: string; agent: string; source: string; usedPct: number | null; pacePct: number | null;
 window: string | null; resetsAt: number | null; verdict: string; signedIn: boolean | null; executors: string[];
 spendUsdWeek: number | null; capUsdWeek: number | null;
}
export interface PlannerMeter {
 eligibility?: import("../../evidence/types").EligibilityDecision;
 runner: string; agent: string; usedPct: number | null; pacePct: number | null; deltaPts: number | null;
 verdict: "behind" | "on_pace" | "ahead" | "out" | "unknown";
 activeHoursLeft: number | null; resetsAt: number | null; window: string | null; stale: boolean;
 advice: string; mode: string; modeHeldUntil?: number;
}
export interface Counts {
 attention: number; problems: number; review: number; running: number; queued: number; ready: number; executors: number; setupOpen: number; hostsWithProblems: number;
 byRepo: Record<string, { review: number; running: number; attention: number }>;
}
export interface Today { since: number; done: number; accepted: number; rejected: number; failed: number; byRepo: Record<string, number> }
export interface HostSummary { alias: string; ssh: string; state: "unknown" | "paused" | "down" | "checking" | "needs_setup" | "ready"; running: number; maxTasks: number; executors: string[]; repos: number }
export interface SetupSummary { complete: boolean; ready?: boolean; open: number; items: import("../../setup/checklist").SetupItem[] }
export interface ServiceInfo { projectStrategyError?: string; version: string; protocol: string; pid: number; startedAt: number; starting?: true; waiting?: import("../../core/path-probe").Waiting; notifier: { client_id: string; kind: import("../../clients/registry").ClientEntry["kind"] } | null }
export interface ReadModelFields {
 desktopUpdates?: import("../../update/desktop/types").UpdateStatus[];
 pause: PauseState | null; attention: AttentionItem[]; service: ServiceInfo; planner: PlannerMeter | null; counts: Counts; today: Today;
 machine: {used: number; max: number; os?: string; arch?: string};
 executors: ExecutorRow[]; accounts: AccountSummary[]; hosts: HostSummary[]; repos: RepoRef[]; setup: SetupSummary;
}
export type ReadModel = ReadModelFields;

export interface PauseState { until: number | null; reason: string | null; by: string | null }
export type SnapshotV2 = Omit<LinkSnapshot, "tasks"> & ReadModelFields & { tasks: TaskDataV2[]; attention: AttentionItem[]; pause?: PauseState | null };
export interface Job {
 id: string; kind: "host.check" | "runner.check" | "host.repo.setup" | "host.clean" | "update.apply";
 target: string; state: "running" | "passed" | "failed" | "cancelled";
 steps: { name: string; state: "pending" | "running" | "passed" | "failed" | "skipped"; detail?: string }[];
 startedAt: number; endedAt?: number; error?: { code: string; message: string; hint?: string };
}
export const ENTITY_EVENT_TYPES = ["desktop.update", "planner", "executor", "account", "host", "repo", "counts", "attention", "job", "activity", "notify"] as const;

export type SnapshotV3 = ReadModelFields & Pick<LinkSnapshot, "seq" | "at" | "mode"> & { tasks: ApiTask[]; strategies: NonNullable<LinkSnapshot["strategies"]> };
