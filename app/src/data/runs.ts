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
  RUN_DETAIL_ERROR,
  RUN_QUESTIONS_ERROR,
  RUNS_EMPTY,
  RUNS_REFRESH_ERROR,
  RUNS_UNAVAILABLE,
  waitsOnLabel,
} from "../../../src/view-model/runs";
import type { BrowserApi } from "./api";

import { runAttentionQueue } from "./runs-badge";

export { RUNS_EMPTY, RUNS_UNAVAILABLE };
export { runAttentionQueue, runsBadgeCount } from "./runs-badge";

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
  /** open | answered | withdrawn (from question.list); absent in attention-derived views. */
  status?: string;
  createdAt?: number;
  answerer?: string;
  answer?: string;
  note?: string;
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

/** A child run (generated plan) read with its own `run.get`. */
export interface RunChildDetail {
  run: Record<string, unknown>;
  steps: unknown[];
  definition?: unknown;
  graphs?: unknown[];
}

/** One message in the orchestrator's thread (`msg.log`). */
export interface RunMessageView { id: string; from: string; to: string; kind: string; body: string; at: number }

export interface RunDetailState {
  id: string;
  run: Record<string, unknown> | null;
  steps: unknown[];
  questions: RunQuestionView[];
  decisions: unknown[];
  /** Additive `run.get` projections (graph versions, artifact metadata, exact definition, pending approval). */
  graphs?: unknown[];
  artifacts?: unknown[];
  definition?: unknown;
  pendingApproval?: unknown;
  /** Orchestrator thread, when `msg.log` is offered and the run has an orchestrator task. */
  messages?: RunMessageView[];
  /** Generated child runs keyed by id (Phase 3 `work_node` plans). */
  children?: Record<string, RunChildDetail>;
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
  parentRunId?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
  const artifactRaw = data.artifact;
  let artifact: RunQuestionView["artifact"];
  if (isObj(artifactRaw) && typeof artifactRaw.id === "string") {
    artifact = { id: artifactRaw.id, ...(typeof artifactRaw.label === "string" ? { label: artifactRaw.label } : {}) };
  } else if (typeof artifactRaw === "string" && artifactRaw) {
    artifact = { id: artifactRaw };
  } else if (typeof data.artifactId === "string") {
    artifact = { id: data.artifactId, ...(typeof data.artifactLabel === "string" ? { label: data.artifactLabel } : {}) };
  }
  return {
    id: data.id,
    runId,
    text: typeof data.text === "string" ? data.text : "",
    answerType: data.answerType as RunAnswerType,
    blocks: typeof data.blocks === "string" ? data.blocks : "step",
    rev: data.rev,
    ...(options ? { options } : {}),
    ...(typeof data.recommended === "string" ? { recommended: data.recommended } : {}),
    ...(artifact ? { artifact } : {}),
    ...(suggested ? { suggestedAnswer: suggested } : {}),
    ...(typeof data.stepId === "string" ? { stepId: data.stepId } : {}),
    ...(typeof data.attempt === "number" && Number.isFinite(data.attempt) ? { attempt: data.attempt } : {}),
    ...(typeof data.branch === "string" && data.branch ? { branch: data.branch } : {}),
    ...(typeof data.status === "string" ? { status: data.status } : {}),
    ...(typeof data.createdAt === "number" && Number.isFinite(data.createdAt) ? { createdAt: data.createdAt } : {}),
    ...(typeof data.answerer === "string" ? { answerer: data.answerer } : {}),
    ...(typeof data.answer === "string" ? { answer: data.answer } : {}),
    ...(typeof data.note === "string" ? { note: data.note } : {}),
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
    // The raw error stays in the console; the page shows plain words (UI-12).
    console.warn("runs: list refresh failed", error);
    return { ...loading, listLoading: false, listError: RUNS_REFRESH_ERROR };
  }
}

/**
 * Apply a finished list refresh onto the latest state. Only list fields are taken, so a detail
 * refresh that finished meanwhile is never overwritten; a failure keeps the rows already shown.
 */
export function mergeListRefresh(current: RunsStoreState, next: RunsStoreState): RunsStoreState {
  if (next.listError) return { ...current, listLoading: false, listError: next.listError };
  return { ...current, list: next.list, listStamp: current.listStamp + 1, listLoading: false, listError: null };
}

/** Apply a finished detail refresh for one run onto the latest state; the list is left alone. */
export function mergeDetailRefresh(current: RunsStoreState, next: RunsStoreState, id: string): RunsStoreState {
  const detail = next.details[id];
  return detail ? { ...current, details: { ...current.details, [id]: detail } } : current;
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
    parentRunId: typeof r.parentRunId === "string" ? r.parentRunId : undefined,
  };
}

const asArray = (v: unknown): unknown[] => Array.isArray(v) ? v : [];

function messageFrom(raw: unknown): RunMessageView | undefined {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.body !== "string") return undefined;
  const at = typeof raw.createdAt === "number" ? raw.createdAt : typeof raw.at === "number" ? raw.at : 0;
  return {
    id: raw.id,
    from: typeof raw.from === "string" ? raw.from : "",
    to: typeof raw.to === "string" ? raw.to : "",
    kind: typeof raw.kind === "string" ? raw.kind : "message",
    body: raw.body,
    at,
  };
}

/** Generated child runs (`parentRunId` = this run), read with their own run.get; capped, failures skipped. */
async function loadChildren(
  api: BrowserApi,
  state: RunsStoreState,
  id: string,
): Promise<Record<string, RunChildDetail>> {
  const ids = state.list.filter(r => r.parentRunId === id).map(r => r.id).slice(0, 8);
  const out: Record<string, RunChildDetail> = {};
  await Promise.all(ids.map(async childId => {
    try {
      const child = await api.call<{ run: Record<string, unknown>; steps?: unknown[]; definition?: unknown; graphs?: unknown[] }>("run.get", { id: childId });
      out[childId] = { run: child.run, steps: asArray(child.steps), definition: child.definition, graphs: asArray(child.graphs) };
    } catch { /* a child that cannot be read is simply not drawn */ }
  }));
  return out;
}

/** Load run.get (+ questions, orchestrator thread and generated child runs when offered) into the detail map. */
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
      decisions?: unknown[];
      graphs?: unknown[];
      artifacts?: unknown[];
      definition?: unknown;
      pendingApproval?: unknown;
    }>("run.get", { id });
    let questions: RunQuestionView[] = [];
    let questionsError: string | null = null;
    const mapQuestions = (rows: unknown): RunQuestionView[] => asArray(rows)
      .map(q => isObj(q) ? questionFromEntity(q, id) : undefined)
      .filter((q): q is RunQuestionView => !!q);
    if (Array.isArray(got.questions)) {
      questions = mapQuestions(got.questions);
    } else if (ops?.has("question.list") || ops === undefined) {
      try { questions = mapQuestions(await api.call<unknown>("question.list", { run: id })); }
      catch (error) {
        console.warn("runs: question list failed", error);
        questionsError = RUN_QUESTIONS_ERROR;
      }
    }
    const taskId = typeof got.run?.orchestratorTaskId === "string" ? got.run.orchestratorTaskId : "";
    let messages: RunMessageView[] | undefined;
    if (taskId && (ops === undefined || ops.has("msg.log"))) {
      try {
        const log = await api.call<{ messages?: unknown[] }>("msg.log", { task: taskId });
        messages = asArray(log?.messages).map(messageFrom).filter((m): m is RunMessageView => !!m);
      } catch (error) {
        console.warn("runs: message log failed", error);
        messages = prev.messages;
      }
    }
    const children = await loadChildren(api, state, id);
    return {
      ...loading,
      details: {
        ...loading.details,
        [id]: {
          id,
          run: got.run,
          steps: asArray(got.steps),
          questions,
          decisions: Array.isArray(got.decisions) ? got.decisions : prev.decisions,
          graphs: asArray(got.graphs),
          artifacts: asArray(got.artifacts),
          definition: got.definition,
          pendingApproval: got.pendingApproval,
          ...(messages ? { messages } : {}),
          children,
          loading: false,
          error: questionsError,
          stamp: prev.stamp + 1,
        },
      },
    };
  } catch (error) {
    console.warn("runs: run load failed", error);
    return {
      ...loading,
      details: { ...loading.details, [id]: { ...prev, loading: false, error: RUN_DETAIL_ERROR } },
    };
  }
}

export type RunSeenResult = "seen" | "unsupported" | "failed";

/** Mark a run seen (Phase 6). The result says whether it happened, so the page never claims it did. */
export async function markRunSeen(api: BrowserApi, id: string, ops: ReadonlySet<string> | undefined): Promise<RunSeenResult> {
  if (ops !== undefined && !ops.has("run.seen")) return "unsupported";
  try {
    await api.call("run.seen", { id });
    return "seen";
  } catch (error) {
    console.warn("runs: mark seen failed", error);
    return "failed";
  }
}
