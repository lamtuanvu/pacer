/** Runs list/detail client store: snapshot.runs, run.list/run.get, and SSE run/step/decision/question entities. */
import type { AttentionItem } from "../../../src/attention/types";
import type { SnapshotRun } from "../../../src/api/read-model/runs";
import {
  displayRunLetter,
  runAge,
  runLettersForList,
  runPriorityLabel,
  runPriorityOf,
  runStatus,
  RUNS_EMPTY,
  RUNS_UNAVAILABLE,
  waitsOnLabel,
} from "../../../src/view-model/runs";
import type { BrowserApi } from "./api";
import { ApiError } from "./api";

export { RUNS_EMPTY, RUNS_UNAVAILABLE };

const ANSWER_TYPES = new Set(["single", "multi", "text", "yes_no", "approve_revise"]);

export type RunAnswerType = "single" | "multi" | "text" | "yes_no" | "approve_revise";

export interface RunQuestionView {
  id: string;
  runId: string;
  text: string;
  answerType: RunAnswerType;
  blocks: string;
  rev: number;
  options?: { value: string; note?: string }[];
  recommended?: string;
  artifact?: { id: string; label?: string };
  suggestedAnswer?: string;
  stepId?: string;
  attempt?: number;
  branch?: string;
}

export interface RunListRow {
  id: string;
  letter: string;
  title: string;
  workflow: string;
  status: string;
  priority: string;
  waitsOn: string;
  age: string;
  createdAt: number;
  pausedReason?: string;
}

export interface RunsListState {
  runs: RunListRow[];
  queue: Array<{ item: AttentionItem; question: RunQuestionView }>;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  empty: boolean;
  badge: number;
}

export interface RunDetailState {
  id: string;
  run: Record<string, unknown> | null;
  steps: unknown[];
  questions: RunQuestionView[];
  decisions: unknown[];
  loading: boolean;
  error: string | null;
  stamp: number;
}

export interface RunsStoreState {
  list: RunSummaryRow[];
  details: Record<string, RunDetailState>;
  listError: string | null;
  listLoading: boolean;
  listStamp: number;
  entityStamp: number;
}

interface RunSummaryRow {
  id: string;
  workflow: string;
  title: string;
  status: string;
  priority?: string;
  letter?: string | null;
  createdAt: number;
  updatedAt?: number;
  reason?: string;
  paused_reason?: string;
  pausedReason?: string;
  waits_on?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Open person-answerable run questions; order is the attention queue's (unblocks → priority → age). */
export function runAttentionQueue(attention: AttentionItem[] | undefined): AttentionItem[] {
  return (attention ?? []).filter(a => a.run && a.kind === "question" && a.question);
}

function optionShape(raw: unknown): { value: string; note?: string } | undefined {
  if (!isObj(raw) || typeof raw.value !== "string" || !raw.value) return undefined;
  return { value: raw.value, ...(typeof raw.note === "string" ? { note: raw.note } : {}) };
}

/** Fail closed on malformed attention questions (same rules as the TUI). */
export function questionFromAttention(item: AttentionItem): RunQuestionView | undefined {
  const q = item.question;
  if (!q || typeof q.id !== "string" || !q.id) return undefined;
  if (typeof q.rev !== "number" || !Number.isFinite(q.rev)) return undefined;
  if (typeof q.answerType !== "string" || !ANSWER_TYPES.has(q.answerType)) return undefined;
  let options: RunQuestionView["options"];
  if (q.options !== undefined) {
    if (!Array.isArray(q.options)) return undefined;
    const parsed = q.options.map(optionShape);
    if (parsed.some(o => !o)) return undefined;
    options = parsed as NonNullable<RunQuestionView["options"]>;
  }
  const suggested = typeof q.suggestedAnswer === "string"
    ? q.suggestedAnswer
    : typeof q.suggested_answer === "string"
      ? q.suggested_answer
      : undefined;
  const artifactRaw = q.artifact;
  let artifact: RunQuestionView["artifact"];
  if (isObj(artifactRaw) && typeof artifactRaw.id === "string") {
    artifact = { id: artifactRaw.id, ...(typeof artifactRaw.label === "string" ? { label: artifactRaw.label } : {}) };
  } else if (typeof q.artifactId === "string") {
    artifact = { id: q.artifactId, ...(typeof q.artifactLabel === "string" ? { label: q.artifactLabel } : {}) };
  }
  return {
    id: q.id,
    runId: item.run!.id,
    text: typeof q.text === "string" ? q.text : item.title,
    answerType: q.answerType as RunAnswerType,
    blocks: typeof q.blocks === "string" ? q.blocks : "step",
    rev: q.rev,
    ...(options ? { options } : {}),
    ...(typeof q.recommended === "string" ? { recommended: q.recommended } : {}),
    ...(artifact ? { artifact } : {}),
    ...(suggested ? { suggestedAnswer: suggested } : {}),
    ...(typeof q.stepId === "string" ? { stepId: q.stepId } : {}),
    ...(typeof q.attempt === "number" && Number.isFinite(q.attempt) ? { attempt: q.attempt } : {}),
    ...(typeof q.branch === "string" && q.branch ? { branch: q.branch } : {}),
  };
}

export function initialRunsStore(): RunsStoreState {
  return { list: [], details: {}, listError: null, listLoading: false, listStamp: 0, entityStamp: 0 };
}

function emptyDetail(id: string): RunDetailState {
  return { id, run: null, steps: [], questions: [], decisions: [], loading: false, error: null, stamp: 0 };
}

/** Map a question.get / entity payload into the Runs question view. */
export function questionFromEntity(data: Record<string, unknown>, runId: string): RunQuestionView | undefined {
  if (typeof data.id !== "string" || typeof data.rev !== "number") return undefined;
  if (typeof data.answerType !== "string" || !ANSWER_TYPES.has(data.answerType)) return undefined;
  let options: RunQuestionView["options"];
  if (Array.isArray(data.options)) {
    const parsed = data.options.map(optionShape);
    if (parsed.some(o => !o)) return undefined;
    options = parsed as NonNullable<RunQuestionView["options"]>;
  }
  const suggested = typeof data.suggestedAnswer === "string"
    ? data.suggestedAnswer
    : typeof data.suggested === "string"
      ? data.suggested
      : undefined;
  return {
    id: data.id,
    runId,
    text: typeof data.text === "string" ? data.text : "",
    answerType: data.answerType as RunAnswerType,
    blocks: typeof data.blocks === "string" ? data.blocks : "step",
    rev: data.rev,
    ...(options ? { options } : {}),
    ...(typeof data.recommended === "string" ? { recommended: data.recommended } : {}),
    ...(suggested ? { suggestedAnswer: suggested } : {}),
  };
}

export function mergeSnapshotRuns(
  list: RunSummaryRow[],
  snapshotRuns: SnapshotRun[] | undefined,
): RunSummaryRow[] {
  if (!snapshotRuns?.length) return list;
  const byId = new Map(list.map(r => [r.id, r]));
  for (const s of snapshotRuns) {
    const prev = byId.get(s.id);
    byId.set(s.id, {
      id: s.id,
      workflow: s.workflow,
      title: s.title || s.workflow,
      status: s.paused_reason ? "paused" : s.status,
      priority: s.priority,
      letter: s.letter,
      createdAt: prev?.createdAt ?? 0,
      waits_on: s.waits_on,
      paused_reason: s.paused_reason,
    });
  }
  return [...byId.values()];
}

function waitsOnFor(run: RunSummaryRow, attention: AttentionItem[]): string {
  if (run.waits_on) return run.waits_on;
  if (attention.some(a => a.run?.id === run.id && a.kind === "question")) return "you";
  if (run.status === "waiting") return "orchestrator";
  return "—";
}

export function buildRunsListState(input: {
  ops: ReadonlySet<string> | undefined;
  attention: AttentionItem[] | undefined;
  snapshotRuns: SnapshotRun[] | undefined;
  store: RunsStoreState;
  now: number;
}): RunsListState {
  const unavailable = input.ops !== undefined && !input.ops.has("run.list");
  const queueItems = runAttentionQueue(input.attention);
  const queue = queueItems
    .map(item => {
      const question = questionFromAttention(item);
      return question ? { item, question } : null;
    })
    .filter((row): row is { item: AttentionItem; question: RunQuestionView } => !!row);

  if (unavailable) {
    return {
      runs: [],
      queue,
      loading: false,
      error: null,
      unavailable: true,
      empty: false,
      badge: queue.length,
    };
  }

  const merged = mergeSnapshotRuns(input.store.list, input.snapshotRuns);
  const letters = runLettersForList(merged);
  const runs: RunListRow[] = merged.map(run => {
    const letter = letters.get(run.id) ?? displayRunLetter(run);
    const paused = run.status === "paused" || !!run.paused_reason || !!run.pausedReason;
    const status = paused ? "paused" : run.status;
    return {
      id: run.id,
      letter,
      title: run.title || run.workflow,
      workflow: run.workflow,
      status,
      priority: runPriorityOf(run.priority),
      waitsOn: waitsOnLabel(waitsOnFor(run, queueItems)),
      age: runAge(run.createdAt, input.now),
      createdAt: run.createdAt,
      pausedReason: run.paused_reason ?? run.pausedReason,
    };
  });

  return {
    runs,
    queue,
    loading: input.store.listLoading && !merged.length,
    error: input.store.listError,
    unavailable: false,
    empty: !merged.length && !queue.length && !input.store.listLoading && !input.store.listError,
    badge: queue.length,
  };
}

export function runRowStatusLabel(status: string): { label: string; tone: "info" | "warn" | "good" | "bad" | "neutral"; glyph: string } {
  return runStatus(status);
}

export function runRowPriorityLabel(priority: string): string {
  return runPriorityLabel(priority);
}

/** Load run.list into the store (keeps previous rows while refreshing). */
export async function refreshRunsList(
  api: BrowserApi,
  state: RunsStoreState,
  ops: ReadonlySet<string> | undefined,
): Promise<RunsStoreState> {
  if (ops !== undefined && !ops.has("run.list")) {
    return { ...state, listLoading: false, listError: null };
  }
  const loading = { ...state, listLoading: true, listError: null };
  try {
    const value = await api.call<RunSummaryRow[]>("run.list", {});
    const list = Array.isArray(value) ? value.map(normalizeListRow) : [];
    return { ...loading, list, listLoading: false, listStamp: loading.listStamp + 1, listError: null };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Couldn't refresh runs";
    return { ...loading, listLoading: false, listError: message };
  }
}

function normalizeListRow(row: RunSummaryRow | Record<string, unknown>): RunSummaryRow {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    workflow: typeof r.workflow === "string" ? r.workflow : "",
    title: typeof r.title === "string" ? r.title : typeof r.workflow === "string" ? r.workflow : String(r.id),
    status: typeof r.status === "string" ? r.status : "running",
    priority: typeof r.priority === "string" ? r.priority : "normal",
    letter: typeof r.letter === "string" ? r.letter : null,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : typeof r.created_at === "number" ? r.created_at : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : undefined,
    reason: typeof r.reason === "string" ? r.reason : undefined,
    paused_reason: typeof r.paused_reason === "string" ? r.paused_reason : undefined,
    pausedReason: typeof r.pausedReason === "string" ? r.pausedReason : undefined,
  };
}

/** Load run.get (+ question.list when available) into the detail map. */
export async function refreshRunDetail(
  api: BrowserApi,
  state: RunsStoreState,
  id: string,
  ops: ReadonlySet<string> | undefined,
): Promise<RunsStoreState> {
  if (ops !== undefined && !ops.has("run.get")) return state;
  const prev = state.details[id] ?? emptyDetail(id);
  const loading: RunsStoreState = {
    ...state,
    details: { ...state.details, [id]: { ...prev, loading: true, error: null } },
  };
  try {
    const got = await api.call<{
      run: Record<string, unknown>;
      steps: unknown[];
      questions?: unknown[];
    }>("run.get", { id });
    let questions: RunQuestionView[] = [];
    if (Array.isArray(got.questions)) {
      questions = got.questions
        .map(q => isObj(q) ? questionFromEntity(q, id) : undefined)
        .filter((q): q is RunQuestionView => !!q);
    } else if (ops?.has("question.list") || ops === undefined) {
      try {
        const listed = await api.call<unknown>("question.list", { run: id });
        if (Array.isArray(listed)) {
          questions = listed
            .map(q => isObj(q) ? questionFromEntity(q, id) : undefined)
            .filter((q): q is RunQuestionView => !!q);
        }
      } catch { /* older services */ }
    }
    return {
      ...loading,
      details: {
        ...loading.details,
        [id]: {
          id,
          run: got.run,
          steps: Array.isArray(got.steps) ? got.steps : [],
          questions,
          decisions: prev.decisions,
          loading: false,
          error: null,
          stamp: prev.stamp + 1,
        },
      },
    };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Couldn't load run";
    return {
      ...loading,
      details: { ...loading.details, [id]: { ...prev, loading: false, error: message } },
    };
  }
}

/** Mark a run seen (Phase 6); no-op when the op is missing. */
export async function markRunSeen(api: BrowserApi, id: string, ops: ReadonlySet<string> | undefined): Promise<void> {
  if (ops !== undefined && !ops.has("run.seen")) return;
  try {
    await api.call("run.seen", { id });
  } catch {
    /* non-blocking: list still works without seen */
  }
}

/** Badge count for the rail: person-answerable run questions. */
export function runsBadgeCount(attention: AttentionItem[] | undefined): number {
  return runAttentionQueue(attention).length;
}
