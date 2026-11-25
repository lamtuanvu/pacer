/** Board 8: several runs at once. Derivations only: the queue's order, ranks and run identity all come from the service. */
import type { AttentionItem } from "../../../../src/attention/types";
import type { ExecutorRow } from "../../../../src/api/read-model/types";
import type { SnapshotRun } from "../../../../src/api/read-model/runs";
import { executorLabel, executorRowStatus } from "../../../../src/view-model/words";
import { runPriorityLabel, runPriorityOf, type RunPriority } from "../../../../src/view-model/runs";
import type { RunDetailState, RunListRow, RunQuestionView } from "../../data/runs";

/** `--chart-1`..`--chart-5`: a run's colour follows its fixed letter, so it never changes while the run lives. */
export const RUN_TONES = 5;
export function runTone(letter: string): number {
  const first = letter.trim().toUpperCase().charCodeAt(0);
  return Number.isFinite(first) && first >= 65 && first <= 90 ? ((first - 65) % RUN_TONES) + 1 : 1;
}

export type Unblocks = "run" | "branch" | "nothing";
export const UNBLOCKS_LABEL: Record<Unblocks, string> = { run: "Stops the run", branch: "Stops a branch", nothing: "Informational" };
const unblocksOf = (item: AttentionItem): Unblocks => item.unblocks === "run" || item.unblocks === "branch" ? item.unblocks : "nothing";

export interface QueueRow {
  id: string;
  runId: string;
  letter: string;
  tone: number;
  runTitle: string;
  priority: RunPriority;
  unblocks: Unblocks;
  rank: string;
  text: string;
  raisedAt: number;
  question: RunQuestionView;
}
export interface StepCounts { running: number; waiting: number; done: number; failed: number }
export interface RunLineRow {
  id: string;
  letter: string;
  tone: number;
  title: string;
  status: string;
  priority: RunPriority;
  priorityLabel: string;
  waitsOn: string;
  age: string;
  pausedReason?: string;
  counts: StepCounts;
  /** Open questions waiting on the person. */
  questions: number;
  summary: { text: string; at?: number } | null;
}
export interface BenchRow { id: string; label: string; state: string; tone: "good" | "info" | "warn" | "bad" | "neutral"; glyph: string; slots: { used: number; max: number } | null }
export interface MultiRunModel {
  lines: RunLineRow[];
  queue: QueueRow[];
  bench: BenchRow[];
  /** Executor slots in use across the bench: the dispatcher's capacity every run shares. */
  capacity: { used: number; max: number } | null;
  hidden: { focus: number; quietRuns: number; quietItems: number; quietBackgroundItems: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Step counts from a run's own step rows (latest attempt per step and branch), for runs the snapshot no longer lists. */
export function countsFromSteps(steps: unknown[] | undefined): StepCounts {
  const latest = new Map<string, { attempt: number; status: string }>();
  for (const s of steps ?? []) {
    if (!isObj(s) || typeof s.stepId !== "string" || typeof s.status !== "string") continue;
    const key = `${s.stepId}\0${typeof s.branch === "string" ? s.branch : ""}`;
    const attempt = typeof s.attempt === "number" ? s.attempt : 0;
    const prev = latest.get(key);
    if (!prev || attempt >= prev.attempt) latest.set(key, { attempt, status: s.status });
  }
  const out: StepCounts = { running: 0, waiting: 0, done: 0, failed: 0 };
  for (const { status } of latest.values()) if (status === "running" || status === "waiting" || status === "done" || status === "failed") out[status]++;
  return out;
}

export function summaryOf(run: Record<string, unknown> | null | undefined): { text: string; at?: number } | null {
  if (!run || typeof run.summary !== "string" || !run.summary.trim()) return null;
  return { text: run.summary.trim(), ...(typeof run.summaryAt === "number" ? { at: run.summaryAt } : {}) };
}

const PRIORITY_RANK: Record<RunPriority, number> = { urgent: 0, normal: 1, background: 2 };

export function buildMultiRun(input: {
  runs: RunListRow[];
  queue: Array<{ item: AttentionItem; question: RunQuestionView }>;
  snapshotRuns: SnapshotRun[] | undefined;
  details: Record<string, RunDetailState | undefined>;
  executors: ExecutorRow[] | undefined;
  focusId: string | null;
  quiet: boolean;
}): MultiRunModel {
  const snap = new Map((input.snapshotRuns ?? []).map(r => [r.id, r]));
  const letters = new Map(input.runs.map(r => [r.id, r.letter]));
  const waiting = new Map<string, number>();
  for (const q of input.queue) waiting.set(q.question.runId, (waiting.get(q.question.runId) ?? 0) + 1);

  const allQueue: QueueRow[] = input.queue.map(({ item, question }) => {
    const letter = item.run?.letter ?? letters.get(question.runId) ?? "?";
    const unblocks = unblocksOf(item);
    return {
      id: question.id, runId: question.runId, letter, tone: runTone(letter), runTitle: item.run?.title ?? question.runId,
      priority: runPriorityOf(item.run?.priority), unblocks, rank: UNBLOCKS_LABEL[unblocks], text: question.text || item.title,
      raisedAt: item.raisedAt, question,
    };
  });
  const allLines: RunLineRow[] = input.runs.map(run => {
    const s = snap.get(run.id);
    return {
      id: run.id, letter: run.letter, tone: runTone(run.letter), title: run.title, status: run.status, priority: runPriorityOf(run.priority),
      priorityLabel: runPriorityLabel(run.priority), waitsOn: run.waitsOn, age: run.age,
      ...(run.pausedReason ? { pausedReason: run.pausedReason } : {}),
      counts: s?.steps ?? countsFromSteps(input.details[run.id]?.steps),
      questions: waiting.get(run.id) ?? 0,
      summary: summaryOf(input.details[run.id]?.run),
    };
  }).sort((a, b) => (b.questions ? 1 : 0) - (a.questions ? 1 : 0) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.letter.localeCompare(b.letter));

  const hidden = { focus: 0, quietRuns: 0, quietItems: 0, quietBackgroundItems: 0 };
  let queue = allQueue;
  let lines = allLines;
  if (input.focusId) {
    hidden.focus = allLines.filter(l => l.id !== input.focusId).length;
    queue = queue.filter(q => q.runId === input.focusId);
    lines = lines.filter(l => l.id === input.focusId);
  }
  if (input.quiet) {
    // Quiet mode keeps what stops work: informational items and background runs wait until the person asks for them.
    // Nothing is hidden silently: the counts are shown.
    const keepRun = (id: string) => (allLines.find(l => l.id === id)?.priority ?? "normal") !== "background";
    const dropped = queue.filter(q => q.unblocks === "nothing" || !keepRun(q.runId));
    hidden.quietBackgroundItems = dropped.filter(q => !keepRun(q.runId)).length;
    hidden.quietItems = dropped.filter(q => q.unblocks === "nothing" && keepRun(q.runId)).length;
    queue = queue.filter(q => !dropped.includes(q));
    hidden.quietRuns = lines.filter(l => l.priority === "background").length;
    lines = lines.filter(l => l.priority !== "background");
  }
  const bench: BenchRow[] = (input.executors ?? []).map(e => {
    const st = executorRowStatus(e);
    return { id: e.id, label: executorLabel(e.id), state: st.label, tone: st.tone, glyph: st.glyph, slots: e.slots ?? null };
  });
  const slotted = bench.filter(b => b.slots);
  const capacity = slotted.length ? { used: slotted.reduce((n, b) => n + b.slots!.used, 0), max: slotted.reduce((n, b) => n + b.slots!.max, 0) } : null;
  return { lines, queue, bench, capacity, hidden };
}

/** Plain words for a run's step counts; zero counts are left out so the line stays short. */
export function countWords(c: StepCounts): string {
  const parts = [c.done && `${c.done} done`, c.running && `${c.running} running`, c.waiting && `${c.waiting} waiting`, c.failed && `${c.failed} failed`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No steps yet";
}
