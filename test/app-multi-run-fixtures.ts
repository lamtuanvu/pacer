/** Three runs at once: A waits on the person, B runs a fan-out, C is a background run with an informational question. */
import type { AttentionItem } from "../src/attention/types";
import type { SnapshotRun } from "../src/api/read-model/runs";
import type { ExecutorRow } from "../src/api/read-model/types";
import type { RunListRow } from "../app/src/data/runs";

export const NOW = 1_000_000;

const item = (id: string, run: { id: string; letter: string; title: string; priority: "urgent" | "normal" | "background" }, unblocks: "run" | "branch" | "nothing", text: string, raisedAt: number, over: Record<string, unknown> = {}): AttentionItem => ({
  id: `a_${id}`, kind: "question", severity: "decide", repo: null, title: text, detail: "", raisedAt, since: raisedAt, actions: [], notify: "all",
  unblocks, run,
  question: { id, rev: 1, answerType: "approve_revise", text, blocks: unblocks === "run" ? "run" : "step", ...over },
});

export const runA = { id: "run_a", letter: "A", title: "Add the Runs board", priority: "urgent" as const };
export const runB = { id: "run_b", letter: "B", title: "Fix the flaky tray test", priority: "normal" as const };
export const runC = { id: "run_c", letter: "C", title: "Tidy the changelog", priority: "background" as const };

/** Already in the service's order: stops-the-run first, then branch, then informational. */
export const attention: AttentionItem[] = [
  item("q_a", runA, "run", "Approve the brainstormed spec?", NOW - 600),
  item("q_b", runB, "branch", "Which reviewer finding should block the merge?", NOW - 300, { answerType: "single", options: [{ value: "first" }, { value: "second" }] }),
  item("q_c", runC, "nothing", "FYI: the changelog has a stale heading. Keep it?", NOW - 120, { answerType: "yes_no" }),
];

const snap = (r: { id: string; letter: string; title: string; priority: "urgent" | "normal" | "background" }, over: Partial<SnapshotRun>): SnapshotRun => ({
  id: r.id, letter: r.letter, title: r.title, workflow: "pacer-dev/feature", status: "running", priority: r.priority, waits_on: "nothing",
  steps: { running: 0, waiting: 0, done: 0, failed: 0 }, orchestrator: { state: "idle" }, ...over,
});
export const snapshotRuns: SnapshotRun[] = [
  snap(runA, { status: "waiting", waits_on: "you", steps: { running: 0, waiting: 1, done: 2, failed: 0 } }),
  snap(runB, { waits_on: "executors", steps: { running: 3, waiting: 1, done: 4, failed: 0 } }),
  snap(runC, { waits_on: "you", steps: { running: 1, waiting: 0, done: 1, failed: 1 } }),
];

export const listRows: RunListRow[] = [
  { id: "run_c", letter: "C", title: runC.title, workflow: "pacer-dev/feature", status: "running", priority: "background", waitsOn: "You", age: "2h ago", createdAt: NOW - 7200 },
  { id: "run_a", letter: "A", title: runA.title, workflow: "pacer-dev/feature", status: "waiting", priority: "urgent", waitsOn: "You", age: "1h ago", createdAt: NOW - 3600 },
  { id: "run_b", letter: "B", title: runB.title, workflow: "pacer-dev/feature", status: "running", priority: "normal", waitsOn: "Executors", age: "30m ago", createdAt: NOW - 1800 },
];

export const executors = [
  { id: "oc-glm", agent: "opencode", account: "a", host: null, model: null, rank: 1, enabled: true, state: "busy", tone: "info", sub: "", usedPct: null, pacePct: null, slots: { used: 2, max: 3 }, lastCheck: null, recentFailures: 0, next: false },
  { id: "codex", agent: "codex", account: "b", host: null, model: null, rank: 2, enabled: true, state: "ready", tone: "good", sub: "", usedPct: null, pacePct: null, slots: { used: 0, max: 2 }, lastCheck: null, recentFailures: 0, next: true },
  { id: "claude-code", agent: "claude", account: "c", host: null, model: null, rank: "planner", enabled: true, state: "exhausted", tone: "warn", sub: "", usedPct: null, pacePct: null, slots: { used: 0, max: 1 }, lastCheck: null, recentFailures: 0, next: false },
] as unknown as ExecutorRow[];
