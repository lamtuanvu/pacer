/**
 * Deterministic layered layout of the engine's run graph for the Live board. The input is `run.get` data only:
 * step rows, the stored definition's edges, and graph versions (with the generated child runs' step rows that
 * fill a zone in). A node exists only for a step row. Definition-only steps (not started, no row) get no node,
 * and edges are drawn only between existing nodes, so the board never invents structure.
 *
 * Steps are desks. A fan-out's branch rows are parallel lanes in one band. A `generate` step carries a zone that
 * shows its graph versions and fills in with the generated child run's steps. Same input, same output, whatever
 * the order the rows arrive in.
 */
import type { RunGraphSummary, RunStepRow } from "../../../../src/dashboard/screens/types";
import { questionMatchesStep } from "../../../../src/view-model/run-tree";

export interface LayoutDefinition {
  entry?: string;
  edges: Array<{ from: string; to: string; when?: string; maxLoops?: number }>;
  steps: Record<string, { type: string; branches?: string[] }>;
}
/** A generated child run: its step rows fill the zone of the parent run's `parentStep`. */
export interface LayoutChild { runId: string; parentStep?: string; createdAt?: number; steps: RunStepRow[]; definition?: LayoutDefinition }
export interface LayoutInput {
  steps: RunStepRow[];
  definition?: LayoutDefinition;
  graphs: Array<Pick<RunGraphSummary, "stepId" | "attempt" | "version" | "status" | "stepCount">>;
  children?: LayoutChild[];
  /** Open questions the person can answer; a waiting step they match is marked as waiting on you. */
  openQuestions?: Array<{ stepId?: string; attempt?: number; branch?: string }>;
}

export const DESK_W = 176;
export const DESK_H = 76;
export const GAP_X = 72;
export const GAP_Y = 44;
const BAND_HEAD = 28;
const BAND_PAD = 12;
const ZONE_HEAD = 52;
const ZONE_PAD = 12;
const ZONE_EMPTY_H = 36;
export const STATION_W = 160;
export const STATION_H = 96;
export const FIGURE = 36;
const ORIGIN_Y = STATION_H + GAP_Y;

export type NodeKind = "desk" | "lane" | "join";
export interface BoardNode {
  id: string;
  kind: NodeKind;
  stepId: string;
  branch?: string;
  attempt: number;
  status: string;
  taskId?: string;
  startedAt: number;
  endedAt?: number;
  x: number; y: number; w: number; h: number;
  layer: number;
  /** Set for steps drawn inside a generated-graph zone. */
  zoneId?: string;
  waitsOnYou: boolean;
}
export interface BoardEdge { id: string; from: string; to: string; x1: number; y1: number; x2: number; y2: number }
export interface BoardBand { id: string; stepId: string; x: number; y: number; w: number; h: number; lanes: number; zoneId?: string }
export interface ZoneVersion { version: number; attempt: number; status: string; stepCount: number }
export interface BoardZone {
  id: string;
  stepId: string;
  x: number; y: number; w: number; h: number;
  versions: ZoneVersion[];
  /** Versions the person or planner approved; the zone fills in only from these. */
  approved: number;
  /** Steps drawn inside (child run step rows). */
  drawn: number;
}
export interface BoardAgent { nodeId: string; taskId: string; x: number; y: number }
export interface BoardStation { x: number; y: number; w: number; h: number }
export interface LiveBoardLayout {
  nodes: BoardNode[];
  edges: BoardEdge[];
  bands: BoardBand[];
  zones: BoardZone[];
  /** One place per running agent: a running step with a task, once per task. */
  agents: BoardAgent[];
  planner: BoardStation;
  /** The person's place: beside the first step that waits on them, else at home next to the planner. */
  person: BoardStation & { at: string | null };
  width: number;
  height: number;
}

const byStart = (a: RunStepRow, b: RunStepRow) => a.startedAt - b.startedAt || a.stepId.localeCompare(b.stepId) || (a.branch ?? "").localeCompare(b.branch ?? "");

/** The latest attempt per (step, branch). */
function latestRows(rows: RunStepRow[]): RunStepRow[] {
  const best = new Map<string, RunStepRow>();
  for (const row of rows) {
    const key = `${row.stepId}\0${row.branch ?? ""}`;
    const prev = best.get(key);
    if (!prev || row.attempt > prev.attempt || (row.attempt === prev.attempt && row.startedAt >= prev.startedAt)) best.set(key, row);
  }
  return [...best.values()].sort(byStart);
}

interface Entry { stepId: string; main?: RunStepRow; branches: RunStepRow[]; first: number }

function entriesOf(rows: RunStepRow[]): Entry[] {
  const map = new Map<string, Entry>();
  for (const row of latestRows(rows)) {
    const e = map.get(row.stepId) ?? { stepId: row.stepId, branches: [], first: row.startedAt };
    if (row.branch) e.branches.push(row); else e.main = row;
    e.first = Math.min(e.first, row.startedAt);
    map.set(row.stepId, e);
  }
  for (const e of map.values()) e.branches.sort((a, b) => (a.branch ?? "").localeCompare(b.branch ?? ""));
  return [...map.values()].sort((a, b) => a.first - b.first || a.stepId.localeCompare(b.stepId));
}

/** Longest-path layer per step over forward edges; loop edges (maxLoops set) are ignored. Without a definition, start order. */
function layersOf(entries: Entry[], def: LayoutDefinition | undefined): Map<string, number> {
  const ids = entries.map(e => e.stepId);
  const level = new Map<string, number>();
  if (!def || !def.edges.length) {
    ids.forEach((id, i) => level.set(id, i));
    return level;
  }
  const present = new Set(ids);
  const forward = def.edges.filter(e => e.maxLoops === undefined && present.has(e.from) && present.has(e.to) && e.from !== e.to);
  for (const id of ids) level.set(id, 0);
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of forward) {
      const next = (level.get(e.from) ?? 0) + 1;
      if (next > (level.get(e.to) ?? 0) && next < ids.length) { level.set(e.to, next); changed = true; }
    }
    if (!changed) break;
  }
  // Close gaps so an absent step does not leave an empty column.
  const used = [...new Set(level.values())].sort((a, b) => a - b);
  const dense = new Map(used.map((v, i) => [v, i] as const));
  for (const [id, v] of level) level.set(id, dense.get(v)!);
  return level;
}

interface Placed { nodes: BoardNode[]; bands: BoardBand[]; edges: BoardEdge[]; w: number; h: number; anchors: Map<string, { left: { x: number; y: number; id: string }; right: { x: number; y: number; id: string } }> }

function isWaitingOnYou(row: RunStepRow, questions: LayoutInput["openQuestions"]): boolean {
  if (row.status !== "waiting" || !questions) return false;
  return questions.some(q => questionMatchesStep(q as { stepId: string; attempt?: number; branch?: string }, row));
}

/** Lay the rows of one run (the root, or a zone's child run) out at (ox, oy), layer by layer. */
interface PlaceOptions { /** Extra height under an entry (a zone under its generate step). */ extraHeight?: (entry: Entry) => number; /** Minimum width of an entry's column. */ minWidth?: (entry: Entry) => number }
type PlaceResult = Placed & { entryExtra: Map<string, number>; origin: Map<string, { x: number; y: number; w: number; h: number }> };
function place(rows: RunStepRow[], def: LayoutDefinition | undefined, ox: number, oy: number, prefix: string, zoneId: string | undefined, questions: LayoutInput["openQuestions"], opts: PlaceOptions = {}): PlaceResult {
  const entries = entriesOf(rows);
  const layerOf = layersOf(entries, def);
  const layerCount = entries.length ? Math.max(...layerOf.values()) + 1 : 0;
  const layers: Entry[][] = Array.from({ length: layerCount }, () => []);
  for (const e of entries) layers[layerOf.get(e.stepId)!]!.push(e);
  const entryExtra = new Map<string, number>();
  const sizeOf = (e: Entry) => {
    const lanes = e.branches.length;
    const extraH = opts.extraHeight ? opts.extraHeight(e) : 0;
    entryExtra.set(e.stepId, extraH);
    if (!lanes) return { w: DESK_W, h: DESK_H };
    const h = BAND_HEAD + lanes * DESK_H + (lanes - 1) * 8 + (e.main ? 8 + DESK_H : 0) + BAND_PAD;
    return { w: DESK_W + 2 * BAND_PAD, h };
  };
  const nodes: BoardNode[] = [];
  const bands: BoardBand[] = [];
  const anchors: Placed["anchors"] = new Map();
  const origin = new Map<string, { x: number; y: number; w: number; h: number }>();
  const layerSizes = layers.map(list => {
    const sized = list.map(e => ({ e, ...sizeOf(e) }));
    const w = Math.max(DESK_W, ...sized.map(s => s.w), ...list.map(e => (opts.minWidth ? opts.minWidth(e) : 0)));
    const h = sized.reduce((sum, s, i) => sum + s.h + (entryExtra.get(s.e.stepId) ?? 0) + (i ? GAP_Y : 0), 0);
    return { sized, w, h };
  });
  const tallest = Math.max(0, ...layerSizes.map(l => l.h));
  let x = ox;
  const nodeBase = (row: RunStepRow, id: string, kind: NodeKind, layer: number, nx: number, ny: number): BoardNode => ({
    id, kind, stepId: row.stepId, ...(row.branch ? { branch: row.branch } : {}), attempt: row.attempt, status: row.status,
    ...(row.taskId ? { taskId: row.taskId } : {}), startedAt: row.startedAt, ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    x: nx, y: ny, w: DESK_W, h: DESK_H, layer, ...(zoneId ? { zoneId } : {}), waitsOnYou: isWaitingOnYou(row, questions),
  });
  layerSizes.forEach((layer, li) => {
    let y = oy + Math.floor((tallest - layer.h) / 2);
    for (const { e, w, h } of layer.sized) {
      origin.set(e.stepId, { x, y, w, h });
      if (!e.branches.length) {
        const row = e.main!;
        const id = `${prefix}${row.stepId}`;
        nodes.push(nodeBase(row, id, "desk", li, x, y));
        anchors.set(e.stepId, { left: { x, y: y + DESK_H / 2, id }, right: { x: x + DESK_W, y: y + DESK_H / 2, id } });
      } else {
        const bandId = `${prefix}${e.stepId}`;
        bands.push({ id: `band:${bandId}`, stepId: e.stepId, x, y, w, h, lanes: e.branches.length, ...(zoneId ? { zoneId } : {}) });
        let ly = y + BAND_HEAD;
        for (const b of e.branches) {
          nodes.push(nodeBase(b, `${prefix}${e.stepId}:${b.branch}`, "lane", li, x + BAND_PAD, ly));
          ly += DESK_H + 8;
        }
        if (e.main) {
          const id = `${prefix}${e.stepId}`;
          nodes.push(nodeBase(e.main, id, "join", li, x + BAND_PAD, ly));
          anchors.set(e.stepId, { left: { x, y: y + h / 2, id: `band:${bandId}` }, right: { x: x + w, y: ly + DESK_H / 2, id } });
        } else {
          anchors.set(e.stepId, { left: { x, y: y + h / 2, id: `band:${bandId}` }, right: { x: x + w, y: y + h / 2, id: `band:${bandId}` } });
        }
      }
      y += h + (entryExtra.get(e.stepId) ?? 0) + GAP_Y;
    }
    x += layer.w + GAP_X;
  });
  const edges: BoardEdge[] = [];
  if (def) {
    for (const edge of def.edges) {
      if (edge.maxLoops !== undefined || edge.from === edge.to) continue;
      const a = anchors.get(edge.from), b = anchors.get(edge.to);
      if (!a || !b) continue;
      edges.push({ id: `${prefix}${edge.from}>${edge.to}`, from: a.right.id, to: b.left.id, x1: a.right.x, y1: a.right.y, x2: b.left.x, y2: b.left.y });
    }
  }
  const w = layerSizes.length ? x - GAP_X - ox : 0;
  return { nodes, bands, edges, w, h: tallest, anchors, entryExtra, origin };
}

function dedupeVersions(graphs: LayoutInput["graphs"], stepId: string): ZoneVersion[] {
  return graphs.filter(g => g.stepId === stepId)
    .map(g => ({ version: g.version, attempt: g.attempt, status: g.status, stepCount: g.stepCount }))
    .sort((a, b) => a.attempt - b.attempt || a.version - b.version);
}

/** The child run that fills a zone: one with live steps first, then the newest, then by id. */
function childFor(children: LayoutChild[], stepId: string): LayoutChild | undefined {
  const live = (c: LayoutChild) => c.steps.some(s => s.status === "running" || s.status === "waiting") ? 1 : 0;
  return children.filter(c => c.parentStep === stepId)
    .sort((a, b) => live(b) - live(a) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.runId.localeCompare(b.runId))[0];
}

export function layoutLiveBoard(input: LayoutInput): LiveBoardLayout {
  const children = input.children ?? [];
  // A zone belongs to a generate step that has a step row; graph versions for a step with no row draw nothing.
  const rowIds = new Set(input.steps.map(r => r.stepId));
  const zoneSteps = [...new Set(input.graphs.map(g => g.stepId))].filter(id => rowIds.has(id)).sort();
  // Zones are sized first: a child run's layout does not depend on the root's.
  const zoneInner = new Map<string, PlaceResult>();
  for (const stepId of zoneSteps) {
    const kid = childFor(children, stepId);
    zoneInner.set(stepId, place(kid?.steps ?? [], kid?.definition, 0, 0, `zone:${stepId}/`, `zone:${stepId}`, input.openQuestions));
  }
  const root = place(input.steps, input.definition, 0, ORIGIN_Y, "", undefined, input.openQuestions, {
    extraHeight: e => {
      const inner = zoneInner.get(e.stepId);
      return inner ? GAP_Y / 2 + ZONE_HEAD + (inner.nodes.length ? inner.h + ZONE_PAD : ZONE_EMPTY_H) : 0;
    },
    minWidth: e => {
      const inner = zoneInner.get(e.stepId);
      return inner ? Math.max(DESK_W, inner.w + 2 * ZONE_PAD) : 0;
    },
  });
  const nodes = [...root.nodes];
  const bands = [...root.bands];
  const edges = [...root.edges];
  const zones: BoardZone[] = [];
  for (const [stepId, inner] of zoneInner) {
    const o = root.origin.get(stepId);
    if (!o) continue;
    const extra = root.entryExtra.get(stepId) ?? 0;
    const zy = o.y + o.h + GAP_Y / 2;
    const versions = dedupeVersions(input.graphs, stepId);
    zones.push({
      id: `zone:${stepId}`, stepId, x: o.x, y: zy, w: Math.max(o.w, inner.w + 2 * ZONE_PAD), h: extra - GAP_Y / 2, versions,
      approved: versions.filter(v => v.status === "approved").length, drawn: inner.nodes.length,
    });
    const dx = o.x + ZONE_PAD, dy = zy + ZONE_HEAD;
    for (const n of inner.nodes) nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
    for (const b of inner.bands) bands.push({ ...b, x: b.x + dx, y: b.y + dy });
    for (const e of inner.edges) edges.push({ ...e, x1: e.x1 + dx, x2: e.x2 + dx, y1: e.y1 + dy, y2: e.y2 + dy });
  }
  const agents: BoardAgent[] = [];
  const seenTasks = new Set<string>();
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (n.status !== "running" || !n.taskId || seenTasks.has(n.taskId)) continue;
    seenTasks.add(n.taskId);
    agents.push({ nodeId: n.id, taskId: n.taskId, x: n.x + 8, y: n.y + DESK_H - FIGURE - 8 });
  }
  const planner: BoardStation = { x: 0, y: 0, w: STATION_W, h: STATION_H };
  const firstWaiting = nodes.filter(n => n.waitsOnYou).sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))[0];
  const person = firstWaiting
    ? { x: firstWaiting.x + firstWaiting.w - FIGURE - 8, y: firstWaiting.y - FIGURE - 4, w: FIGURE, h: FIGURE, at: firstWaiting.id }
    : { x: STATION_W + GAP_X, y: 0, w: STATION_W, h: STATION_H, at: null };
  const right = Math.max(STATION_W + GAP_X + STATION_W, ...nodes.map(n => n.x + n.w), ...bands.map(b => b.x + b.w), ...zones.map(z => z.x + z.w));
  const bottom = Math.max(ORIGIN_Y, ...nodes.map(n => n.y + n.h), ...bands.map(b => b.y + b.h), ...zones.map(z => z.y + z.h));
  nodes.sort((a, b) => a.layer - b.layer || a.x - b.x || a.y - b.y || a.id.localeCompare(b.id));
  return { nodes, edges, bands, zones, agents, planner, person, width: right, height: bottom };
}
