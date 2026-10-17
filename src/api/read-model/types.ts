import type { TaskData } from "../../link/envelope";

export interface RepoRef { key: string; label: string; path: string }
export type TaskDataV2 = TaskData & { repo: RepoRef; kind: string | null; host: string | null };
export type ApiTask = TaskDataV2;
export interface ExecutorRow {
 id: string; agent: string; account: string; host: string | null; model: string | null;
 rank: number | "planner"; enabled: boolean;
 state: "ready" | "busy" | "full" | "failing" | "down" | "blocked" | "exhausted" | "disabled" | "checking";
 tone: "good" | "info" | "warn" | "bad" | "muted";
 sub: string; reason?: string; usedPct: number | null; pacePct: number | null; paceReason?: string;
 slots: { used: number; max: number }; lastCheck: { at: number; passed: boolean; detail?: string } | null;
 recentFailures: number; next: boolean;
}
export interface AccountSummary {
 name: string; agent: string; source: string; usedPct: number | null; pacePct: number | null;
 window: string | null; resetsAt: number | null; verdict: string; signedIn: boolean | null; executors: string[];
}
export interface PlannerMeter {
 runner: string; agent: string; usedPct: number | null; pacePct: number | null; deltaPts: number | null;
 verdict: "behind" | "on_pace" | "ahead" | "out" | "unknown";
 activeHoursLeft: number | null; resetsAt: number | null; window: string | null; stale: boolean;
 advice: string; mode: string; modeHeldUntil?: number;
}
export interface Counts {
 review: number; running: number; queued: number; ready: number; executors: number; setupOpen: number; hostsWithProblems: number;
 byRepo: Record<string, { review: number; running: number }>;
}
export interface Today { since: number; done: number; accepted: number; rejected: number; failed: number; byRepo: Record<string, number> }
export interface HostSummary { alias: string; ssh: string; state: "unknown"; running: number; maxTasks: number; executors: string[]; repos: number }
export interface SetupSummary { complete: boolean; open: number; items: { id: string; title: string; status: string; required: boolean }[] }
export interface ServiceInfo { version: string; protocol: string; pid: number; startedAt: number }
export interface ReadModelFields {
 service: ServiceInfo; planner: PlannerMeter | null; counts: Counts; today: Today;
 executors: ExecutorRow[]; accounts: AccountSummary[]; hosts: HostSummary[]; repos: RepoRef[]; setup: SetupSummary;
}
export type ReadModel = ReadModelFields;
