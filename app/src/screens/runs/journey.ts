/**
 * Board 7: the journey of a run, replayed from what the engine recorded. Events come from step rows (when each step
 * started and ended, which task ran it), recorded decisions (the router's choice, plan approvals) and graph versions
 * (plan construction). Nothing is guessed: an event exists only because a row, a decision, a graph version or a
 * generated child run does. Every child run of a generate step is replayed, in the order they started.
 * Playback is read-only and pure; the screen only walks the index.
 */
import { actorLabel, decisionKindLabel, decisionRows } from "../../../../src/view-model/run-board";
import { runStatus } from "../../../../src/view-model/runs";
import type { RunStepRow } from "../../../../src/dashboard/screens/types";
import type { LayoutChild, LayoutInput, LiveBoardLayout } from "./live-board-layout";
import { graphStatusLabel, nodeLabel } from "./live-board-model";

export type JourneyKind = "start" | "router" | "decision" | "plan" | "plan_start" | "arrive" | "step" | "leave" | "step_end" | "finish";
const RANK: Record<JourneyKind, number> = { start: 0, router: 1, decision: 1, arrive: 2, step: 2, plan: 3, plan_start: 3.5, leave: 4, step_end: 4, finish: 5 };

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
  /** Graph version keys (`attempt/version`): the one a plan event drafts, the one an event approves, the one a step ran in. */
  planKey?: string;
  approves?: string;
  plan?: string;
  /** Step events: which attempt (in replay order), how it ended up, and whether its end was recorded. */
  attempt?: number;
  status?: string;
  hasEnd?: boolean;
  /** The engine's decision kind and step, for decision events (structured, never read from the wording). */
  decisionKind?: string;
  stepId?: string;
}
export interface Journey { events: JourneyEvent[]; finished: boolean; carried: Record<string, string[]> }

/** One recorded attempt of a step, placed on the desk it belongs to. */
export interface JourneyRow {
  nodeId: string; attempt: number; status: string; taskId?: string; startedAt: number; endedAt?: number;
  /** Replay order between a desk's rows, when attempts restart in a later child run. Defaults to `attempt`. */
  order?: number;
  /** The graph version whose child run holds the row, and its words when a step has more than one child run. */
  plan?: string; planLabel?: string;
}
/** A generated child run, matched to the graph version it runs. */
export interface PlanChild { zoneId: string; key: string; createdAt?: number; failedAt?: number }
export interface Replay { layoutInput: LayoutInput; rows: JourneyRow[]; plans: PlanChild[]; carried: Record<string, string[]> }

const LIVE_ROW = new Set(["running", "waiting", "pending"]);
const ENDED_RUN = new Set(["done", "failed", "stopped"]);
/** The engine names a generated definition `gen/<run>/<step>/a<attempt>/v<version>`. */
const GENERATED = /\/a(\d+)\/v(\d+)$/;

/**
 * What the replay draws and walks: all of a generate step's child runs merged into one, oldest first. A replan copies
 * finished steps into the new child as already done rows (src/workflow/engine.ts `seedFinishedAndResume`: no task,
 * attempt 1, ended the moment they were inserted); those are carried over, not replayed a second time.
 */
export function replayOf(input: LayoutInput): Replay {
  const rows: JourneyRow[] = input.steps.map(r => ({ nodeId: `${r.stepId}${r.branch ? `:${r.branch}` : ""}`, attempt: r.attempt, status: r.status, taskId: r.taskId, startedAt: r.startedAt, endedAt: r.endedAt }));
  const plans: PlanChild[] = [];
  const carried: Record<string, string[]> = {};
  const merged: LayoutChild[] = [];
  const steps = new Set((input.children ?? []).map(c => c.parentStep).filter((s): s is string => !!s));
  for (const stepId of steps) {
    const kids = (input.children ?? []).filter(c => c.parentStep === stepId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.runId.localeCompare(b.runId));
    // Without a generated name, the newest child runs the newest version that was ever approved.
    const approved = input.graphs.filter(g => g.stepId === stepId && (g.status === "approved" || g.status === "superseded"))
      .sort((a, b) => a.attempt - b.attempt || a.version - b.version);
    const kept: LayoutChild["steps"] = [];
    const done = new Set<string>();
    kids.forEach((kid, k) => {
      const named = GENERATED.exec(kid.workflow ?? "");
      const fallback = approved[approved.length - kids.length + k];
      const attempt = named ? Number(named[1]) : fallback?.attempt;
      const version = named ? Number(named[2]) : fallback?.version;
      const key = attempt !== undefined && version !== undefined ? `${attempt}/${version}` : undefined;
      const failed = kid.steps.filter(r => r.status === "failed" && r.endedAt !== undefined).map(r => r.endedAt!);
      if (key) plans.push({ zoneId: `zone:${stepId}`, key, createdAt: kid.createdAt, ...(failed.length ? { failedAt: Math.max(...failed) } : {}) });
      const next = kids[k + 1];
      for (const r of kid.steps) {
        const nodeId = `zone:${stepId}/${r.stepId}${r.branch ? `:${r.branch}` : ""}`;
        const seeded = k > 0 && !r.taskId && !r.branch && r.attempt === 1 && r.status === "done" && r.endedAt !== undefined && r.endedAt - r.startedAt <= 1 && done.has(r.stepId);
        if (seeded) { if (key) (carried[nodeId] ??= []).push(key); continue; }
        // A replaced child that has ended runs nothing more, whatever its unfinished rows still say.
        const cut = r.endedAt === undefined && next && ENDED_RUN.has(kid.status ?? "") && LIVE_ROW.has(r.status);
        const endedAt = cut ? Math.max(r.startedAt, Math.min(kid.updatedAt ?? Infinity, next.createdAt ?? Infinity)) : r.endedAt;
        const status = cut ? "stopped" : r.status;
        const order = k * 1000 + r.attempt;
        kept.push({ ...r, attempt: order, status, ...(Number.isFinite(endedAt) ? { endedAt } : {}) });
        rows.push({ nodeId, attempt: r.attempt, order, status, taskId: r.taskId, startedAt: r.startedAt, ...(Number.isFinite(endedAt) ? { endedAt } : {}),
          ...(key ? { plan: key } : {}), ...(kids.length > 1 && version !== undefined ? { planLabel: `plan v${version}` } : {}) });
      }
      for (const r of kid.steps) if (r.status === "done" && !r.branch) done.add(r.stepId);
    });
    const defs = kids.map(c => c.definition).filter(d => !!d);
    const edges = new Map(defs.flatMap(d => d.edges).map(e => [`${e.from}>${e.to}`, e] as const));
    const last = kids[kids.length - 1]!;
    merged.push({
      runId: last.runId, parentStep: stepId, createdAt: last.createdAt, steps: kept,
      ...(defs.length ? { definition: { edges: [...edges.values()], steps: Object.assign({}, ...defs.map(d => d.steps)) } } : {}),
    });
  }
  return { layoutInput: { ...input, children: merged }, rows, plans, carried };
}

export interface JourneyInput {
  /** All attempts. Without them only the board's latest rows are replayed. */
  rows?: JourneyRow[];
  plans?: PlanChild[];
  carried?: Record<string, string[]>;
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
  const decided = new Map<string, Draft>();
  for (const d of decisions) {
    const type = input.stepTypes?.[d.stepId]?.type;
    if (type === "choose_workflow" && d.kind === "choose") {
      drafts.push({ at: d.at, kind: "router", text: `The router chose ${d.choice}`, ...(d.reason ? { detail: d.reason } : {}) });
    } else {
      const label = `${actorLabel(d.actor)}: ${decisionKindLabel(d.kind)}${d.choice ? ` (${d.choice})` : ""}`;
      const draft: Draft = { at: d.at, kind: "decision", text: d.stepId ? `${label} · ${d.stepId}` : label, decisionKind: d.kind, stepId: d.stepId, ...(d.reason ? { detail: d.reason } : {}) };
      decided.set(d.id, draft);
      drafts.push(draft);
    }
  }
  // Plan construction: one event per graph version. Versions carry no time of their own. A version is approved when its
  // approval was recorded, or else when its child run started. Version 1 of an attempt is drafted when that attempt of the
  // generate step started; a later one after what ended the one before (a revision, or its child's failed step).
  for (const zone of layout.zones) {
    const gen = layout.nodes.find(n => n.id === zone.stepId && !n.zoneId);
    if (!gen) continue;
    const onStep = decisions.filter(d => d.stepId === zone.stepId).sort((a, b) => a.at - b.at);
    const approvals = onStep.filter(d => d.kind === "approve_graph" || (d.kind === "decide" && /^approve/i.test(d.choice)));
    const revisions = onStep.filter(d => d.kind === "revise_graph" || (d.kind === "decide" && /^revise/i.test(d.choice)));
    const used = new Set<string>();
    let previous: { at: number; attempt: number; failedAt?: number; childAt?: number; approvedAt?: number } | null = null;
    for (const v of zone.versions) {
      const key = `${v.attempt}/${v.version}`;
      const child = input.plans?.find(p => p.zoneId === zone.id && p.key === key);
      const free = approvals.filter(d => !used.has(d.id));
      const approval = free.find(d => d.choice === String(v.version) && (!d.attempt || d.attempt === v.attempt))
        ?? (child?.createdAt !== undefined || v.status === "approved"
          ? free.filter(d => !/^\d+$/.test(d.choice) && (!d.attempt || d.attempt === v.attempt) && d.at <= (child?.createdAt ?? Infinity) && d.at >= (previous?.approvedAt ?? 0)).pop()
          : undefined);
      if (approval) used.add(approval.id);
      const approvedAt = approval?.at ?? child?.createdAt;
      let at: number;
      if (!previous || previous.attempt !== v.attempt) {
        const starts = (input.rows ?? []).filter(r => r.nodeId === gen.id && r.attempt === v.attempt).map(r => r.startedAt);
        at = starts.length ? Math.min(...starts) : gen.startedAt;
      } else {
        const after: number = previous.at;
        const ends = [...revisions.map(d => d.at), ...(previous.failedAt !== undefined ? [previous.failedAt + 0.5] : [])]
          .filter(t => t >= after && t <= (approvedAt ?? Infinity));
        at = ends.length ? Math.max(...ends) : approvedAt !== undefined ? approvedAt - 0.5 : after;
      }
      if (approvedAt !== undefined && at >= approvedAt) at = approvedAt - 0.5;
      const again = v.attempt > 1 ? ` (attempt ${v.attempt})` : "";
      drafts.push({ at, kind: "plan", text: `The planner drafts plan v${v.version}${again} (${v.stepCount} ${v.stepCount === 1 ? "step" : "steps"})`, zoneId: zone.id, version: v.version, planKey: key });
      const draft = approval ? decided.get(approval.id) : undefined;
      if (draft) Object.assign(draft, { zoneId: zone.id, approves: key });
      else if (approvedAt !== undefined) drafts.push({ at: approvedAt, kind: "plan_start", text: `Plan v${v.version}${again} starts`, zoneId: zone.id, version: v.version, approves: key });
      previous = { at, attempt: v.attempt, failedAt: child?.failedAt, approvedAt };
    }
  }
  const seenExecutors = new Set<string>();
  const rows: JourneyRow[] = input.rows ?? layout.nodes.map(n => ({ nodeId: n.id, attempt: n.attempt, status: n.status, taskId: n.taskId, startedAt: n.startedAt, endedAt: n.endedAt }));
  const nodes = new Map(layout.nodes.map(n => [n.id, n]));
  const byStart = [...rows].sort((a, b) => a.startedAt - b.startedAt || a.nodeId.localeCompare(b.nodeId) || (a.order ?? a.attempt) - (b.order ?? b.attempt));
  for (const r of byStart) {
    const node = nodes.get(r.nodeId);
    if (!node) continue;
    const words = [r.planLabel, r.attempt > 1 ? `attempt ${r.attempt}` : ""].filter(Boolean).join(", ");
    const label = words ? `${nodeLabel(node)} (${words})` : nodeLabel(node);
    const facts = { nodeId: r.nodeId, attempt: r.order ?? r.attempt, status: r.status, hasEnd: r.endedAt !== undefined, ...(r.plan ? { plan: r.plan } : {}) };
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
  return { events: drafts.map((d, index) => ({ ...d, index })), finished, carried: input.carried ?? {} };
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
    const keys = new Set(plans.map(e => e.planKey));
    const shownVersions = z.versions.filter(v => keys.has(`${v.attempt}/${v.version}`));
    const latest = shownVersions[shownVersions.length - 1];
    const latestKey = latest ? `${latest.attempt}/${latest.version}` : "";
    const approvalPlayed = upto.some(e => e.zoneId === z.id && e.approves === latestKey);
    // Steps of this version's child run, with the finished ones it carried over; every drawn step when no child is known.
    const started = layout.nodes.filter(n => n.zoneId === z.id && visible.has(n.id)
      && (!current.get(n.id)?.plan || current.get(n.id)!.plan === latestKey || journey.carried[n.id]?.includes(latestKey))).length;
    let line: string;
    let approved = false;
    if (!latest) line = "Planning has not produced a version yet";
    else {
      // The newest version is proposed until its own approval; once the generate step has finished it shows its final status.
      const status = genEnded ? latest.status : approvalPlayed ? "approved" : "proposed";
      approved = status === "approved";
      const prev = shownVersions.length > 1 ? shownVersions[shownVersions.length - 2]! : undefined;
      line = `v${latest.version} ${graphStatusLabel(status)} · ${latest.stepCount} ${latest.stepCount === 1 ? "step" : "steps"}${approved ? ` · ${started} started` : ""}${prev ? ` · v${prev.version} ${graphStatusLabel(prev.status)}` : ""}`;
    }
    zones.set(z.id, { drafted, line, approved });
  }
  return { index, event: index >= 0 ? journey.events[index] ?? null : null, visible, status, working, zones };
}
