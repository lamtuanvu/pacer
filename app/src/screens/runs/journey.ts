/**
 * Board 7: the journey of a run, replayed from what the engine recorded. Events come from step rows (when each step
 * started and ended, which task ran it), recorded decisions (the router's choice, plan approvals) and graph versions
 * (plan construction). Nothing is guessed: an event exists only because a row, a decision or a graph version does.
 * Playback is read-only and pure; the screen only walks the index.
 */
import { actorLabel, decisionKindLabel, decisionRows } from "../../../../src/view-model/run-board";
import { runStatus } from "../../../../src/view-model/runs";
import type { LiveBoardLayout } from "./live-board-layout";
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
  /** The engine's decision kind and step, for decision events (structured, never read from the wording). */
  decisionKind?: string;
  stepId?: string;
}
export interface Journey { events: JourneyEvent[]; finished: boolean }

export interface JourneyInput {
  run: { createdAt?: number; updatedAt?: number; status?: string; title?: string };
  layout: LiveBoardLayout;
  decisions: unknown[] | undefined;
  /** Step types from the stored definition, to recognise the router's step. */
  stepTypes?: Record<string, { type: string }>;
  executorOf: (taskId: string) => string;
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
      const at = i === 0 ? gen.startedAt : onStep[i - 1]?.at ?? gen.endedAt ?? gen.startedAt;
      drafts.push({ at, kind: "plan", text: `The planner drafts plan v${v.version} (${v.stepCount} ${v.stepCount === 1 ? "step" : "steps"})`, zoneId: zone.id, version: v.version });
    });
  }
  const seenExecutors = new Set<string>();
  const byStart = [...layout.nodes].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const n of byStart) {
    const label = nodeLabel(n);
    if (n.taskId) {
      const executor = input.executorOf(n.taskId);
      const isNew = !seenExecutors.has(executor);
      seenExecutors.add(executor);
      drafts.push({ at: n.startedAt, kind: "arrive", nodeId: n.id, taskId: n.taskId, executor, ...(isNew ? { newExecutor: true } : {}),
        text: isNew ? `${executor} joins and takes ${label}; its mascot is generated` : `${executor} arrives at ${label}` });
      if (n.endedAt !== undefined) {
        drafts.push({ at: n.endedAt, kind: "leave", nodeId: n.id, taskId: n.taskId, executor, text: `${executor} leaves ${label} · ${runStatus(n.status).label}` });
      }
    } else {
      drafts.push({ at: n.startedAt, kind: "step", nodeId: n.id, text: `${label} starts` });
      if (n.endedAt !== undefined) drafts.push({ at: n.endedAt, kind: "step_end", nodeId: n.id, text: `${label} finished · ${runStatus(n.status).label}` });
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
  const startIdx = new Map<string, number>();
  const endIdx = new Map<string, number>();
  const executorOfNode = new Map<string, string>();
  for (const e of journey.events) {
    if (!e.nodeId) continue;
    if (e.kind === "arrive" || e.kind === "step") startIdx.set(e.nodeId, e.index);
    if (e.kind === "leave" || e.kind === "step_end") endIdx.set(e.nodeId, e.index);
    if (e.executor) executorOfNode.set(e.nodeId, e.executor);
  }
  const visible = new Set<string>();
  const status = new Map<string, string>();
  const working: Frame["working"] = [];
  for (const n of layout.nodes) {
    const s = startIdx.get(n.id);
    if (s === undefined || s > index) continue;
    visible.add(n.id);
    const e = endIdx.get(n.id);
    const ended = e !== undefined ? e <= index : TERMINAL.has(n.status);
    // Without a recorded end, a finished step is shown finished from its start; waiting and pending steps keep their state.
    const st = ended ? n.status : n.status === "waiting" || n.status === "pending" ? n.status : "running";
    status.set(n.id, st);
    if (st === "running" && n.taskId) working.push({ nodeId: n.id, taskId: n.taskId, executor: executorOfNode.get(n.id) ?? "unknown executor" });
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
