/**
 * Run view derivations (boards 1-5) from `run.get` data only. Framework-free so the app and a
 * future TUI share one reading. Nothing here invents structure: strips, reviewer lanes, waves and
 * evidence all come from step rows, the stored definition, graph versions and artifact metadata.
 */
import type { RunDecision, RunDetail, RunQuestion, RunStepRow } from "../dashboard/screens/types";
import { buildRunTree, stepAwaitsReview, stepTypeOf, type TreeLine } from "./run-tree";
import { stepMarkerFor, type StepMarker } from "./runs";
import { fanoutAttempt, latestFanoutRows } from "../workflow/fanout";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v : undefined;
const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The question fields the run view needs; both the TUI and app question shapes satisfy it. */
export type BoardQuestion = Pick<RunQuestion, "id" | "text" | "stepId" | "attempt" | "branch"> & {
  status?: string; answerer?: string; answer?: string; note?: string; answerType?: string; createdAt?: number;
};

export interface BoardMessage { id: string; from: string; to: string; kind: string; body: string; at: number }

export interface ArtifactMeta { id: string; label: string; name: string; mime: string; size: number; stepId: string; attempt?: number }

export interface BoardChild { run: { id: string }; steps: RunStepRow[]; definition?: RunDetail["definition"] }

export interface BoardInput {
  detail: RunDetail;
  artifacts?: unknown[];
  questions?: BoardQuestion[];
  decisions?: unknown[];
  messages?: BoardMessage[];
  /** Generated child runs, read with their own `run.get`. */
  children?: Record<string, BoardChild>;
  /** Task liveness by task id, from the snapshot. */
  liveness?: ReadonlyMap<string, { stalled: boolean; reason: string; waitingOn?: string; since: number }>;
}

export function artifactMetas(raw: unknown[] | undefined): ArtifactMeta[] {
  const out: ArtifactMeta[] = [];
  for (const a of raw ?? []) {
    if (!isObj(a) || typeof a.id !== "string") continue;
    out.push({
      id: a.id,
      label: str(a.label) ?? str(a.name) ?? a.id,
      name: str(a.name) ?? a.id,
      mime: str(a.mime) ?? "application/octet-stream",
      size: num(a.size) ?? 0,
      stepId: str(a.stepId) ?? "",
      ...(num(a.attempt) !== undefined ? { attempt: num(a.attempt)! } : {}),
    });
  }
  return out;
}

export function decisionRows(raw: unknown[] | undefined): RunDecision[] {
  const out: RunDecision[] = [];
  for (const d of raw ?? []) {
    if (!isObj(d) || typeof d.id !== "string") continue;
    out.push({
      id: d.id,
      runId: str(d.runId) ?? "",
      stepId: str(d.stepId) ?? "",
      attempt: num(d.attempt) ?? 0,
      actor: str(d.actor) ?? "",
      kind: str(d.kind) ?? "",
      choice: str(d.choice) ?? "",
      reason: str(d.reason) ?? "",
      at: num(d.at) ?? 0,
    });
  }
  return out;
}

/** Who made a decision, in plain words (UI-12). */
export function actorLabel(actor: string): string {
  if (actor === "person" || actor === "human" || actor === "you") return "You";
  if (actor === "orchestrator" || actor === "planner") return "Planner";
  if (actor === "engine") return "Engine";
  return actor || "Unknown";
}

/** Plain words for a decision kind. Unknown kinds fall back to the kind with underscores removed. */
export function decisionKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    choose: "Chose a path", answer: "Answered", approve_graph: "Approved the plan", revise_graph: "Asked for a revision",
    publish_approved: "Approved publishing", published: "Published", decide: "Decided", skip: "Skipped a step", retry: "Retried a step",
  };
  return labels[kind] ?? (kind.replace(/_/g, " ") || "Decision");
}

/* ---------------------------------------------------------------- Board 1: strip + rail */

export interface StripStep {
  id: string;
  stepId: string;
  attempt: number;
  label: string;
  type?: string;
  status: string;
  marker: StepMarker;
  waitsOnYou: boolean;
  awaitsReview?: boolean;
  attempts: number;
  progress?: { done: number; total: number };
  taskId?: string;
}

function branchProgress(lines: TreeLine[], fanoutIndex: number): { done: number; total: number } {
  let done = 0, total = 0;
  for (let i = fanoutIndex + 1; i < lines.length && lines[i]!.depth > 0; i++) {
    if (lines[i]!.id.startsWith("graph:")) continue;
    total++;
    if (lines[i]!.status === "done") done++;
  }
  return { done, total };
}

/** The step strip: engine order, one chip per root step. Fan-outs carry branch progress. */
export function stripSteps(detail: RunDetail, questions: BoardQuestion[]): StripStep[] {
  const open = questions.filter(q => (q.status === undefined || q.status === "open") && (q.answerer === undefined || q.answerer === "person"));
  const lines = buildRunTree(detail, open as RunQuestion[]);
  const out: StripStep[] = [];
  lines.forEach((line, i) => {
    if (line.depth !== 0 || line.id.startsWith("graph:")) return;
    const type = stepTypeOf(detail, line.stepId);
    const next = lines[i + 1];
    const progress = type === "fanout" || (next && next.depth > 0 && !next.id.startsWith("graph:"))
      ? branchProgress(lines, i)
      : undefined;
    out.push({
      id: line.id, stepId: line.stepId, attempt: line.attempt, label: line.label, ...(type ? { type } : {}),
      status: line.status, marker: stepMarkerFor({ status: line.status, waitsOnYou: line.waitsOnYou }),
      waitsOnYou: line.waitsOnYou, attempts: line.attempts, ...(line.awaitsReview ? { awaitsReview: true } : {}),
      ...(progress && progress.total ? { progress } : {}),
      ...(line.taskId ? { taskId: line.taskId } : {}),
    });
  });
  return out;
}

export type RailEntry =
  | { kind: "decision"; id: string; at: number; stepId: string; actor: string; title: string; reason: string }
  | { kind: "question"; id: string; at: number; stepId?: string; text: string; status: string; answer?: string; note?: string }
  | { kind: "message"; id: string; at: number; from: string; to: string; body: string; mine: boolean };

/** Decisions with reasons, questions and messages to the planner, oldest first. */
export function conversationRail(input: Pick<BoardInput, "decisions" | "questions" | "messages">, orchestratorTaskId?: string): RailEntry[] {
  const entries: RailEntry[] = [];
  for (const d of decisionRows(input.decisions)) {
    entries.push({ kind: "decision", id: d.id, at: d.at, stepId: d.stepId, actor: actorLabel(d.actor), title: d.choice ? `${decisionKindLabel(d.kind)}: ${d.choice}` : decisionKindLabel(d.kind), reason: d.reason });
  }
  for (const q of input.questions ?? []) {
    entries.push({
      kind: "question", id: q.id, at: q.createdAt ?? 0, ...(q.stepId ? { stepId: q.stepId } : {}), text: q.text,
      status: q.status ?? "open", ...(q.answer ? { answer: q.answer } : {}), ...(q.note ? { note: q.note } : {}),
    });
  }
  for (const m of input.messages ?? []) {
    const toPlanner = !!orchestratorTaskId && m.to === `task:${orchestratorTaskId}`;
    entries.push({ kind: "message", id: m.id, at: m.at, from: m.from, to: m.to, body: m.body, mine: toPlanner });
  }
  return entries.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at - b.e.at) || (a.i - b.i)).map(x => x.e);
}

/* ---------------------------------------------------------------- Board 3: reviewer panel */

export interface ReviewerLane {
  branch: string;
  status: string;
  marker: StepMarker;
  verdict?: string;
  summary?: string;
  findings: string[];
  taskId?: string;
  error?: string;
  awaitsReview?: boolean;
}
export interface ReviewerPanelData {
  stepId: string;
  attempt: number;
  status: string;
  lanes: ReviewerLane[];
  join?: { status: string; verdict?: string; summary?: string };
  decisions: RunDecision[];
}

function findingsOf(result: unknown): string[] {
  if (!isObj(result) || !Array.isArray(result.findings)) return [];
  const out: string[] = [];
  for (const f of result.findings) {
    if (typeof f === "string" && f.trim()) out.push(f);
    else if (isObj(f)) {
      const text = str(f.text) ?? str(f.summary) ?? str(f.title) ?? str(f.message);
      const sev = str(f.severity);
      if (text) out.push(sev ? `${sev}: ${text}` : text);
    }
  }
  return out;
}

/** One panel per fan-out step that has branch rows, from the step rows (never from names). */
export function reviewerPanels(detail: RunDetail, decisions: unknown[] | undefined): ReviewerPanelData[] {
  const byStep = new Map<string, RunStepRow[]>();
  for (const s of detail.steps) {
    if (stepTypeOf(detail, s.stepId) === "fanout" || s.branch) {
      const list = byStep.get(s.stepId) ?? [];
      list.push(s);
      byStep.set(s.stepId, list);
    }
  }
  const allDecisions = decisionRows(decisions);
  const panels: ReviewerPanelData[] = [];
  for (const [stepId, rows] of byStep) {
    // A retried branch belongs to the fan-out attempt it replaces a branch of.
    const current = latestFanoutRows(rows);
    const attempt = Math.max(...current.map(fanoutAttempt));
    const lanes: ReviewerLane[] = current.filter(r => r.branch).sort((a, b) => (a.branch ?? "").localeCompare(b.branch ?? "")).map(r => {
      const res = isObj(r.result) ? r.result : undefined;
      return {
        branch: r.branch!, status: r.status, marker: stepMarkerFor({ status: r.status }),
        ...(str(res?.verdict) ? { verdict: str(res?.verdict)! } : {}),
        ...(str(res?.summary) ? { summary: str(res?.summary)! } : {}),
        findings: findingsOf(r.result),
        ...(r.taskId ? { taskId: r.taskId } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(stepAwaitsReview(r) ? { awaitsReview: true } : {}),
      };
    });
    if (!lanes.length) continue;
    const joinRow = current.find(r => !r.branch);
    const jres = joinRow && isObj(joinRow.result) ? joinRow.result : undefined;
    const status = joinRow?.status
      ?? (lanes.some(l => l.status === "failed") ? "failed" : lanes.some(l => l.status === "running") ? "running" : lanes.every(l => l.status === "done") ? "done" : "waiting");
    panels.push({
      stepId, attempt, status, lanes,
      ...(joinRow ? { join: { status: joinRow.status, ...(str(jres?.verdict) ? { verdict: str(jres?.verdict)! } : {}), ...(str(jres?.summary) ? { summary: str(jres?.summary)! } : {}) } } : {}),
      decisions: allDecisions.filter(d => d.stepId === stepId),
    });
  }
  return panels;
}

/* ---------------------------------------------------------------- Board 4: execution waves */

export interface WaveStep {
  stepId: string;
  label: string;
  status: string;
  marker: StepMarker;
  taskId?: string;
  /** Ids this step waits for, from the definition's edges. */
  after: string[];
  /** True when the step has not started because something it waits for is not done. */
  blocked: boolean;
  /** No step row exists yet. */
  notStarted: boolean;
  awaitsReview?: boolean;
  liveness?: { stalled: boolean; reason: string; waitingOn?: string; since: number };
}
export interface Wave { index: number; steps: WaveStep[] }
export interface WavesData {
  /** `generated` when a child run supplies the plan; `plain` for the run's own steps. */
  source: "generated" | "plain";
  runId: string;
  waves: Wave[];
}

type Edge = { from: string; to: string; maxLoops?: number };

/** Longest-path level per step over forward edges; back edges (with maxLoops) are ignored. */
function levelsFor(ids: string[], edges: Edge[]): Map<string, number> {
  const idSet = new Set(ids);
  const forward = edges.filter(e => idSet.has(e.from) && idSet.has(e.to) && e.maxLoops === undefined);
  const level = new Map<string, number>(ids.map(i => [i, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of forward) {
      const next = (level.get(e.from) ?? 0) + 1;
      if (next > (level.get(e.to) ?? 0) && next <= ids.length) { level.set(e.to, next); changed = true; }
    }
    if (!changed) break;
  }
  return level;
}

function wavesFor(steps: RunStepRow[], definition: RunDetail["definition"] | undefined, liveness: BoardInput["liveness"]): Wave[] {
  const latest = new Map<string, RunStepRow>();
  for (const s of steps) {
    if (s.branch) continue;
    const prev = latest.get(s.stepId);
    if (!prev || s.attempt >= prev.attempt) latest.set(s.stepId, s);
  }
  for (const s of steps) if (s.branch && !latest.has(s.stepId)) latest.set(s.stepId, s);
  const defIds = definition ? Object.keys(definition.steps).filter(id => definition.steps[id]!.type !== "end") : [];
  const ids = [...new Set([...defIds, ...latest.keys()])];
  if (!ids.length) return [];
  const edges: Edge[] = (definition?.edges ?? []).map(e => ({ from: e.from, to: e.to, ...(e.maxLoops !== undefined ? { maxLoops: e.maxLoops } : {}) }));
  const level = definition ? levelsFor(ids, edges) : new Map(
    [...latest.values()].sort((a, b) => a.startedAt - b.startedAt || a.stepId.localeCompare(b.stepId)).map((s, i) => [s.stepId, i] as const),
  );
  const after = (id: string) => edges.filter(e => e.to === id && e.maxLoops === undefined && ids.includes(e.from)).map(e => e.from);
  const waves = new Map<number, WaveStep[]>();
  for (const id of ids) {
    const row = latest.get(id);
    const deps = after(id);
    const blocked = !row && deps.some(d => (latest.get(d)?.status ?? "pending") !== "done");
    const live = row?.taskId ? liveness?.get(row.taskId) : undefined;
    const item: WaveStep = {
      stepId: id, label: id, status: row?.status ?? "pending",
      marker: row ? stepMarkerFor({ status: row.status }) : "unknown",
      ...(row?.taskId ? { taskId: row.taskId } : {}),
      after: deps, blocked, notStarted: !row,
      ...(row && stepAwaitsReview(row) ? { awaitsReview: true } : {}),
      ...(live ? { liveness: live } : {}),
    };
    const l = level.get(id) ?? 0;
    const list = waves.get(l) ?? [];
    list.push(item);
    waves.set(l, list);
  }
  return [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([, list], index) => ({ index: index + 1, steps: list }));
}

/** Waves from the generated child run when one exists (Phase 3), else from the run's own steps. */
export function executionWaves(input: BoardInput): WavesData | null {
  const children = Object.values(input.children ?? {}).filter(c => c.steps.length > 0);
  if (children.length) {
    const live = (c: BoardChild) => c.steps.some(s => s.status === "running" || s.status === "waiting") ? 1 : 0;
    const child = [...children].sort((a, b) => live(b) - live(a))[0]!;
    return { source: "generated", runId: child.run.id, waves: wavesFor(child.steps, child.definition, input.liveness) };
  }
  const waves = wavesFor(input.detail.steps, input.detail.definition, input.liveness);
  return waves.length ? { source: "plain", runId: input.detail.run.id, waves } : null;
}

/* ---------------------------------------------------------------- Board 5: tests and PR */

export type EvidenceStatus = "pass" | "fail" | "unverified";
export interface EvidenceSurfaceView { name: string; status: EvidenceStatus; steps: string[]; artifacts: ArtifactMeta[]; missingArtifacts: string[] }
export interface EvidenceView {
  stepId: string;
  attempt: number;
  branch?: string;
  summary: string;
  passed: number;
  failed: number;
  unverified: number;
  surfaces: EvidenceSurfaceView[];
  report?: ArtifactMeta;
}

export function evidenceStatusLabel(status: EvidenceStatus): { label: string; tone: "good" | "bad" | "warn"; glyph: string } {
  if (status === "pass") return { label: "Passed", tone: "good", glyph: "✓" };
  if (status === "fail") return { label: "Failed", tone: "bad", glyph: "✕" };
  return { label: "Unverified", tone: "warn", glyph: "?" };
}

function asEvidence(step: RunStepRow, byId: Map<string, ArtifactMeta>): EvidenceView | null {
  const r = step.result;
  if (!isObj(r) || !Array.isArray(r.surfaces)) return null;
  const passed = num(r.passed), failed = num(r.failed), unverified = num(r.unverified);
  if (passed === undefined || failed === undefined || unverified === undefined) return null;
  const surfaces: EvidenceSurfaceView[] = [];
  for (const s of r.surfaces) {
    if (!isObj(s) || typeof s.name !== "string") continue;
    const status: EvidenceStatus = s.status === "pass" || s.status === "fail" ? s.status : "unverified";
    const ids = Array.isArray(s.artifacts) ? s.artifacts.filter((a): a is string => typeof a === "string") : [];
    surfaces.push({
      name: s.name, status,
      steps: Array.isArray(s.steps) ? s.steps.filter((x): x is string => typeof x === "string") : [],
      artifacts: ids.map(id => byId.get(id)).filter((a): a is ArtifactMeta => !!a),
      missingArtifacts: ids.filter(id => !byId.has(id)),
    });
  }
  const report = typeof r.report === "string" ? byId.get(r.report) : undefined;
  return {
    stepId: step.stepId, attempt: step.attempt, ...(step.branch ? { branch: step.branch } : {}),
    summary: str(r.summary) ?? "", passed, failed, unverified, surfaces, ...(report ? { report } : {}),
  };
}

export interface TestsAndPrData {
  evidence: EvidenceView[];
  artifacts: ArtifactMeta[];
  branch?: string;
  baseRef?: string;
  prUrl?: string;
  conflicts: number;
  publishQuestions: BoardQuestion[];
}

/** True for the question that asks the person to approve publishing (matched on its step id). */
export function isPublishQuestion(q: Pick<BoardQuestion, "stepId">): boolean {
  return typeof q.stepId === "string" && /publish/i.test(q.stepId);
}

export function testsAndPr(input: BoardInput): TestsAndPrData {
  const artifacts = artifactMetas(input.artifacts);
  const byId = new Map(artifacts.map(a => [a.id, a]));
  const latest = new Map<string, RunStepRow>();
  for (const s of input.detail.steps) {
    const key = `${s.stepId}\0${s.branch ?? ""}`;
    const prev = latest.get(key);
    if (!prev || s.attempt >= prev.attempt) latest.set(key, s);
  }
  const evidence: EvidenceView[] = [];
  for (const s of latest.values()) {
    const e = asEvidence(s, byId);
    if (e) evidence.push(e);
  }
  const run = input.detail.run as unknown as Record<string, unknown>;
  return {
    evidence, artifacts,
    ...(str(run.branch) ? { branch: str(run.branch)! } : {}),
    ...(str(run.baseRef) ? { baseRef: str(run.baseRef)! } : {}),
    ...(str(run.prUrl) ? { prUrl: str(run.prUrl)! } : {}),
    conflicts: Array.isArray(run.conflict) ? run.conflict.length : 0,
    publishQuestions: (input.questions ?? []).filter(q => (q.status ?? "open") === "open" && isPublishQuestion(q)),
  };
}

/** Which boards the run has data for (the run view only offers those; UI-13). */
export interface BoardAvailability { brainstorm: boolean; review: boolean; execution: boolean; tests: boolean }
export function boardAvailability(input: BoardInput, hasOrchestratorTask: boolean): BoardAvailability {
  const t = testsAndPr(input);
  return {
    brainstorm: hasOrchestratorTask,
    review: reviewerPanels(input.detail, input.decisions).length > 0,
    // Waves are for the execution phase: a generated child run, or three or more root steps already under way.
    execution: Object.keys(input.children ?? {}).length > 0
      || new Set(input.detail.steps.filter(s => !s.branch).map(s => s.stepId)).size >= 3,
    tests: t.evidence.length > 0 || !!t.branch || !!t.prUrl || t.publishQuestions.length > 0,
  };
}

/** First letter capitalised, for the orchestrator block line. */
export function sentenceCase(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** The forming spec: the artifact the person asked to see, else the newest one labelled like a spec, else the newest. */
export function pickSpecArtifact(artifacts: ArtifactMeta[], requested?: string | null): ArtifactMeta | undefined {
  if (requested) { const hit = artifacts.find(a => a.id === requested); if (hit) return hit; }
  const specs = artifacts.filter(a => /spec|design|brief/i.test(`${a.label} ${a.name}`));
  const pool = specs.length ? specs : artifacts;
  return pool[pool.length - 1];
}

/** The planner needs the person's eye when the engine reports it blocked or retrying (structured state, not wording). */
export function orchestratorNeedsAttention(orch: { state?: string } | null | undefined): boolean {
  return orch?.state === "blocked" || orch?.state === "retrying";
}
