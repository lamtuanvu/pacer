/** Turns `run.get` detail into the Live board's layout input and the text the board is described by. */
import type { RunGraphSummary, RunStepRow } from "../../../../src/dashboard/screens/types";
import type { RunDetailState } from "../../data/runs";
import type { BoardNode, LayoutChild, LayoutDefinition, LayoutInput } from "./live-board-layout";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isStepRow(v: unknown): v is RunStepRow {
  return isObj(v) && typeof v.stepId === "string" && typeof v.status === "string" && typeof v.attempt === "number" && typeof v.startedAt === "number";
}
const stepRows = (rows: unknown[]): RunStepRow[] => rows.filter(isStepRow);

export function definitionOf(raw: unknown): LayoutDefinition | undefined {
  if (!isObj(raw) || !Array.isArray(raw.edges) || !isObj(raw.steps)) return undefined;
  const edges = raw.edges.filter((e): e is LayoutDefinition["edges"][number] => isObj(e) && typeof e.from === "string" && typeof e.to === "string");
  return { ...(typeof raw.entry === "string" ? { entry: raw.entry } : {}), edges, steps: raw.steps as LayoutDefinition["steps"] };
}

function graphRows(raw: unknown[] | undefined): LayoutInput["graphs"] {
  return (raw ?? []).filter((g): g is RunGraphSummary => isObj(g) && typeof g.stepId === "string" && typeof g.version === "number")
    .map(g => ({ stepId: g.stepId, attempt: typeof g.attempt === "number" ? g.attempt : 1, version: g.version, status: String(g.status ?? ""), stepCount: typeof g.stepCount === "number" ? g.stepCount : 0 }));
}

/** The board's input: step rows, definition edges, graph versions and the generated child runs. Nothing else. */
export function layoutInputFromDetail(detail: Pick<RunDetailState, "steps" | "definition" | "graphs" | "children">, questions: LayoutInput["openQuestions"]): LayoutInput {
  const def = definitionOf(detail.definition);
  const children: LayoutChild[] = Object.entries(detail.children ?? {}).map(([runId, c]) => ({
    runId,
    ...(typeof c.run.parentStep === "string" ? { parentStep: c.run.parentStep } : {}),
    ...(typeof c.run.createdAt === "number" ? { createdAt: c.run.createdAt } : {}),
    steps: stepRows(c.steps),
    ...(definitionOf(c.definition) ? { definition: definitionOf(c.definition)! } : {}),
  }));
  return { steps: stepRows(detail.steps), ...(def ? { definition: def } : {}), graphs: graphRows(detail.graphs), children, openQuestions: questions };
}

export const nodeLabel = (n: Pick<BoardNode, "stepId" | "branch">): string => n.branch ? `${n.stepId} · ${n.branch}` : n.stepId;

export function shortLabel(text: string, max = 24): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function executorOf(taskId: string, tasks: ReadonlyArray<{ id: string; executor?: string | null }> | undefined): string {
  const t = tasks?.find(x => x.id === taskId);
  return t?.executor ? t.executor : "unknown executor";
}
