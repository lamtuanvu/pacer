// Protocol 2.1 read model: the snapshot fields and entity events from the UI functionality spec
// (docs/specs/2026-10-16-ui-functionality-design.md, sections 1, 2, 4, 6, 8, 9 and 10).
// Types only. Shared with the service implementation: the service imports these rather than defining its own.
import type { LinkSnapshot, TaskData } from "../link/envelope";

export interface RepoRef { key: string; label: string; path: string }

export interface TaskDataV2 extends TaskData {
  repo?: RepoRef;
  kind?: string | null;
  kindSource?: "brief" | "classifier" | "review";
  host?: string | null;
  queue?: { reason: "no_slot" | "paused" | "host_down" | "waiting_retry"; position: number };
  acceptance?: { cmd: string; state: "pending" | "running" | "passed" | "failed" | "none"; durationS?: number; summary?: string; machine?: string | null };
  diffstat?: { files: number; added: number; removed: number };
  idleS?: number;
  rev?: number;
}

export interface Action { label: string; op: string; params: Record<string, unknown>; style?: "primary" | "danger"; confirm?: string }
export type AttentionKind = "review" | "failed" | "limit" | "stuck" | "question" | "account_signin" | "executor_down" | "host_down" | "planner_quota" | "setup" | "update";
export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: "decide" | "problem" | "blocked";
  repo: RepoRef | null;
  taskId?: string; executor?: string; host?: string; account?: string;
  title: string;
  detail: string;
  raisedAt: number;
  actions: Action[];
  notify: "important" | "all";
  since: number;
  snoozedUntil?: number;
}

export interface ExecutorRow {
  id: string;
  agent: string; account: string; host: string | null; model: string | null;
  rank: number | "planner";
  enabled: boolean;
  state: "ready" | "busy" | "full" | "failing" | "down" | "blocked" | "exhausted" | "disabled" | "checking";
  tone: "good" | "info" | "warn" | "bad" | "muted";
  sub: string;
  reason?: string;
  usedPct: number | null; pacePct: number | null;
  paceReason?: string;
  slots: { used: number; max: number };
  lastCheck: { at: number; passed: boolean; detail?: string } | null;
  recentFailures: number;
  next: boolean;
}
export interface AccountSummary {
  name: string; agent: string; source: string;
  usedPct: number | null; pacePct: number | null; window: string | null; resetsAt: number | null;
  verdict: string; signedIn: boolean | null; executors: string[];
}
export interface PlannerMeter {
  runner: string; agent: string;
  usedPct: number | null; pacePct: number | null; deltaPts: number | null;
  verdict: "behind" | "on_pace" | "ahead" | "out" | "unknown";
  activeHoursLeft: number | null; resetsAt: number | null; window: string | null; stale: boolean;
  advice: string;
  mode: string; modeHeldUntil?: number;
}
export interface Counts {
  attention: number; review: number; problems: number; running: number; queued: number; ready: number; executors: number;
  setupOpen: number; hostsWithProblems: number;
  byRepo: Record<string, { attention: number; running: number }>;
}
export interface Today { since: number; done: number; accepted: number; rejected: number; failed: number; byRepo: Record<string, { done: number; accepted: number }> }
/** Assumed shape: the functionality spec names the states but not the fields. */
export interface HostSummary { alias: string; state: "ready" | "needs_setup" | "down" | "paused" | "checking"; problem?: string }
/** Assumed shape: the functionality spec gives no fields. */
export interface SetupSummary { open: number }
export interface PauseState { until: number; reason?: string; by?: string }
export interface ServiceInfo { version: string; protocol: string; startedAt: number; pid: number; notifier?: string | null }
export interface Job {
  id: string; kind: "host.check" | "runner.check" | "host.repo.setup" | "host.clean" | "update.apply";
  target: string;
  state: "running" | "passed" | "failed" | "cancelled";
  steps: { name: string; state: "pending" | "running" | "passed" | "failed" | "skipped"; detail?: string }[];
  startedAt: number; endedAt?: number; error?: { code: string; message: string; hint?: string };
}
export interface ActivityEntry { id: string; at: number; kind: string; level: "info" | "warn" | "error"; text: string; repo?: string; taskId?: string; executor?: string; host?: string }

/** Fields added in protocol 2.1. All optional: a 2.0 service sends none of them. */
export interface ReadModelFields {
  service?: ServiceInfo;
  planner?: PlannerMeter | null;
  counts?: Counts;
  attention?: AttentionItem[];
  executors?: ExecutorRow[];
  accounts?: AccountSummary[];
  hosts?: HostSummary[];
  repos?: RepoRef[];
  today?: Today;
  setup?: SetupSummary;
  pause?: PauseState | null;
}
export type SnapshotV2 = Omit<LinkSnapshot, "tasks"> & ReadModelFields & { tasks: TaskDataV2[] };
export const ENTITY_EVENT_TYPES = ["attention", "executor", "account", "host", "repo", "job", "activity", "counts", "pause"] as const;
export type EntityEventType = (typeof ENTITY_EVENT_TYPES)[number];
/** An entity event carries the whole entity, or { id, removed: true } when it goes away. */
export interface Removed { id: string; removed: true }
