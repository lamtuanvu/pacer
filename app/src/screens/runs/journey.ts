/**
 * Board 7: the journey of a run, replayed from what the engine recorded. Events come from step rows (when each step
 * started and ended, which task ran it), recorded decisions (the router's choice, plan approvals) and graph versions
 * (plan construction). Nothing is guessed: an event exists only because a row, a decision or a graph version does.
 * Playback is read-only and pure; the screen only walks the index.
 */
import { actorLabel, decisionKindLabel, decisionRows } from "../../../../src/view-model/run-board";
import { runStatus } from "../../../../src/view-model/runs";
import type { RunStepRow } from "../../../../src/dashboard/screens/types";
import { childFor, type LayoutInput, type LiveBoardLayout } from "./live-board-layout";
import { graphStatusLabel, nodeLabel } from "./live-board-model";

export type JourneyKind = "start" | "router" | "decision" | "plan" | "arrive" | "step" | "leave" | "step_end" | "finish";
const RANK: Record<JourneyKind, number> = { start: 0, router: 1, decision: 1, arrive: 2, step: 2, plan: 3, leave: 4, step_end: 4, finish: 5 };

export interface JourneyEvent {
  index: number;
  at: number;
  kind: JourneyKind;
  text: string;
  detail?: string;
  nodeId?: string;
  taskId?: string;
  executor?: string;
  /** First time this executor appears: its mascot is generated here. */
  newExecutor?: boolean;
  zoneId?: string;
  version?: number;
  /** Step events: which attempt, how it ended up, and whether its end was recorded. */
  attempt?: number;
  status?: string;
  hasEnd?: boolean;
  /** The engine's decision kind and step, for decision events (structured, never read from the wording). */
  decisionKind?: string;
  stepId?: string;
}
export interface Journey { events: JourneyEvent[]; finished: boolean }

/** One recorded attempt of a step, placed on the desk it belongs to. */
export interface JourneyRow { nodeId: string; attempt: number; status: string; taskId?: string; startedAt: number; endedAt?: number }

/** Every step row, all attempts, for the desks the board draws (the board itself shows only each desk's latest). */
export function journeyRows(input: LayoutInput, layout: LiveBoardLayout): JourneyRow[] {
  const desks = new Set(layout.nodes.map(n => n.id));
  const place = (rows: RunStepRow[], prefix: string): JourneyRow[] => rows.flatMap(r => {
    const nodeId = `${prefix}${r.stepId}${r.branch ? `:${r.branch}` : ""}`;
    return desks.has(nodeId) ? [{ nodeId, attempt: r.attempt, status: r.status, ...(r.taskId ? { taskId: r.taskId } : {}), startedAt: r.startedAt, ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}) }] : [];
  });
  return [...place(input.steps, ""), ...layout.zones.flatMap(z => place(childFor(input.children ?? [], z.stepId)?.steps ?? [], `${z.id}/`))];
}

export interface JourneyInput {
  /** All attempts. Without them only the board's latest rows are replayed. */
  rows?: JourneyRow[];
  run: { createdAt?: number; updatedAt?: number; status?: string; title?: string };
  layout: LiveBoardLayout;
  decisions: unknown[] | undefined;
  /** Step types from the stored definition, to recognise the router's step. */
  stepTypes?: Record<string, { type: string }>;
  /** The executor identity behind a task (seeds the mascot); "" when unknown. */
  executorOf: (taskId: string) => string;
  /** What the screen says for an identity. Defaults to the identity itself. */
  executorName?: (identity: string) => string;
}

type Draft = Omit<JourneyEvent, "index">;
const TERMINAL = new Set(["done", "failed", "stopped"]);

export function buildJourney(input: JourneyInput): Journey {
  const { layout } = input;
  const drafts: Draft[] = [];
  if (typeof input.run.createdAt === "number" && input.run.createdAt > 0) {
    drafts.push({ at: input.run.createdAt, kind: "start", text: input.run.title ? `Run started: ${input.run.title}` : "Run started" });
  }
  const decisions = decisionRows(input.decisions);
  for (const d of decisions) {
    const type = input.stepTypes?.[d.stepId]?.type;
    if (type === "choose_workflow" && d.kind === "choose") {
      drafts.push({ at: d.at, kind: "router", text: `The router chose ${d.choice}`, ...(d.reason ? { detail: d.reason } : {}) });
    } else {
      const label = `${actorLabel(d.actor)}: ${decisionKindLabel(d.kind)}${d.choice ? ` (${d.choice})` : ""}`;
      drafts.push({ at: d.at, kind: "decision", text: d.stepId ? `${label} · ${d.stepId}` : label, decisionKind: d.kind, stepId: d.stepId, ...(d.reason ? { detail: d.reason } : {}) });
    }
  }
  // Plan construction: one event per graph version. Versions carry no time of their own, so version 1 is placed when the
  // generate step started, and each later version when the next decision on that step was recorded.
  for (const zone of layout.zones) {
    const gen = layout.nodes.find(n => n.id === zone.stepId && !n.zoneId);
    if (!gen) continue;
    const onStep = decisions.filter(d => d.stepId === zone.stepId).sort((a, b) => a.at - b.at);
    zone.versions.forEach((v, i) => {
      const firstStart = Math.min(gen.startedAt, ...(input.rows ?? []).filter(r => r.nodeId === gen.id).map(r => r.startedAt));
      const at = i === 0 ? firstStart : onStep[i - 1]?.at ?? gen.endedAt ?? gen.startedAt;
      drafts.push({ at, kind: "plan", text: `The planner drafts plan v${v.version} (${v.stepCount} ${v.stepCount === 1 ? "step" : "steps"})`, zoneId: zone.id, version: v.version });
    });
  }
  const seenExecutors = new Set<string>();
  const rows: JourneyRow[] = input.rows ?? layout.nodes.map(n => ({ nodeId: n.id, attempt: n.attempt, status: n.status, taskId: n.taskId, startedAt: n.startedAt, endedAt: n.endedAt }));
  const nodes = new Map(layout.nodes.map(n => [n.id, n]));
  const byStart = [...rows].sort((a, b) => a.startedAt - b.startedAt || a.nodeId.localeCompare(b.nodeId) || a.attempt - b.attempt);
  for (const r of byStart) {
    const node = nodes.get(r.nodeId);
    if (!node) continue;
    const label = r.attempt > 1 ? `${nodeLabel(node)} (attempt ${r.attempt})` : nodeLabel(node);
    const facts = { nodeId: r.nodeId, attempt: r.attempt, status: r.status, hasEnd: r.endedAt !== undefined };
    if (r.taskId) {
      const executor = input.executorOf(r.taskId);
      const name = (input.executorName ?? ((id: string) => id))(executor);
      const isNew = !seenExecutors.has(executor);
      seenExecutors.add(executor);
      drafts.push({ at: r.startedAt, kind: "arrive", ...facts, taskId: r.taskId, executor, ...(isNew ? { newExecutor: true } : {}),
        text: isNew ? `${name} joins and takes ${label}; its mascot is generated` : `${name} arrives at ${label}` });
      if (r.endedAt !== undefined) {
        drafts.push({ at: r.endedAt, kind: "leave", ...facts, taskId: r.taskId, executor, text: `${name} leaves ${label} · ${runStatus(r.status).label}` });
      }
    } else {
      drafts.push({ at: r.startedAt, kind: "step", ...facts, text: `${label} starts` });
      if (r.endedAt !== undefined) drafts.push({ at: r.endedAt, kind: "step_end", ...facts, text: `${label} finished · ${runStatus(r.status).label}` });
    }
  }
  const finished = TERMINAL.has(input.run.status ?? "");
  const last = Math.max(0, ...drafts.map(d => d.at));
  if (finished) drafts.push({ at: Math.max(last, input.run.updatedAt ?? 0), kind: "finish", text: `Run ${runStatus(input.run.status!).label.toLowerCase()}` });
  drafts.sort((a, b) => a.at - b.at || RANK[a.kind] - RANK[b.kind] || (a.nodeId ?? "").localeCompare(b.nodeId ?? "") || a.text.localeCompare(b.text));
  return { events: drafts.map((d, index) => ({ ...d, index })), finished };
}

export interface Frame {
  index: number;
  event: JourneyEvent | null;
  /** Desks that exist at this point: their step has started. */
  visible: Set<string>;
  status: Map<string, string>;
  /** Agents with a place now: tasks whose step is running at this point. */
  working: Array<{ nodeId: string; taskId: string; executor: string }>;
  zones: Map<string, { drafted: number; line: string; approved: boolean }>;
}

/** The state of the board once events 0..index have played. `index` -1 is the empty board before anything happened. */
export function frameAt(journey: Journey, layout: LiveBoardLayout, index: number): Frame {
  const upto = journey.events.slice(0, Math.max(0, index + 1));
  // Per desk, the latest attempt that has started by now. Order between attempts comes from the attempt number, not from ties in time.
  const current = new Map<string, JourneyEvent>();
  for (const e of upto) {
    if (!e.nodeId || (e.kind !== "arrive" && e.kind !== "step")) continue;
    const held = current.get(e.nodeId);
    if (!held || (e.attempt ?? 1) >= (held.attempt ?? 1)) current.set(e.nodeId, e);
  }
  const visible = new Set<string>();
  const status = new Map<string, string>();
  const working: Frame["working"] = [];
  for (const n of layout.nodes) {
    const start = current.get(n.id);
    if (!start) continue;
    visible.add(n.id);
    const final = start.status ?? n.status;
    const ended = start.hasEnd
      ? upto.some(e => e.nodeId === n.id && (e.kind === "leave" || e.kind === "step_end") && e.attempt === start.attempt)
      : TERMINAL.has(final);
    // Without a recorded end, a finished step is shown finished from its start; waiting and pending steps keep their state.
    const st = ended ? final : final === "waiting" || final === "pending" ? final : "running";
    status.set(n.id, st);
    if (st === "running" && start.taskId) working.push({ nodeId: n.id, taskId: start.taskId, executor: start.executor ?? "" });
  }
  const zones = new Map<string, { drafted: number; line: string; approved: boolean }>();
  for (const z of layout.zones) {
    const gen = layout.nodes.find(n => n.id === z.stepId && !n.zoneId);
    if (!gen || !visible.has(gen.id)) continue;
    const plans = upto.filter(e => e.kind === "plan" && e.zoneId === z.id);
    const drafted = plans.length;
    const genEnded = status.get(gen.id) !== "running" && status.get(gen.id) !== "waiting";
    const approvalPlayed = upto.some(e => e.kind === "decision" && e.decisionKind === "approve_graph" && e.stepId === z.stepId);
    const shownVersions = z.versions.slice(0, drafted);
    const latest = shownVersions[shownVersions.length - 1];
    const started = layout.nodes.filter(n => n.zoneId === z.id && visible.has(n.id)).length;
    let line: string;
    let approved = false;
    if (!latest) line = "Planning has not produced a version yet";
    else {
      // The newest version is only proposed until it is approved or the generate step has finished; older ones were superseded and keep their final status.
      const status = genEnded || approvalPlayed ? latest.status : "proposed";
      approved = status === "approved";
      const prev = shownVersions.length > 1 ? shownVersions[shownVersions.length - 2]! : undefined;
      line = `v${latest.version} ${graphStatusLabel(status)} · ${latest.stepCount} ${latest.stepCount === 1 ? "step" : "steps"}${approved ? ` · ${started} started` : ""}${prev ? ` · v${prev.version} ${graphStatusLabel(prev.status)}` : ""}`;
    }
    zones.set(z.id, { drafted, line, approved });
  }
  return { index, event: index >= 0 ? journey.events[index] ?? null : null, visible, status, working, zones };
}
