import type { TaskDetail } from "../../../../src/core/task-detail";
import type { scopedWorkTree } from "../../../../src/core/work";
import { runnerAgent } from "../../../../src/view-model/agents";
import { compactCount } from "../../../../src/view-model/task-tree";
import { kindCopy, reasonCopy, timelineCopy } from "../../../../src/view-model/copy";
import { executorLabel, taskStatus } from "../../../../src/view-model/words";

export type TraceTree = ReturnType<typeof scopedWorkTree>;
export type TraceNode = TraceTree["nodes"][number];
export interface TraceDecision {
  attempt: number;
  selectedCandidateId?: string;
  proposal: { state: string; choices?: {id:string;reason:string}[]; step?:string; reason?:string } | null;
}
export interface TraceStep {
  at: number | null; title: string; detail: string; agents: string[]; tokens: string; children?: TraceNode[];
}
export function tokenValue(tokens?: {total:number;measuredAttempts:number;partialAttempts:number;lowerBound?:boolean} | null): string {
  return !tokens || tokens.measuredAttempts + tokens.partialAttempts === 0 ? "—" : `${tokens.lowerBound ? "≥ " : ""}${compactCount(tokens.total)}`;
}
export function candidateAgent(id: string): string {
  try { const binding: unknown = JSON.parse(id); if (Array.isArray(binding) && typeof binding[0] === "string") return binding[0]; } catch { /* Legacy runner ids are already displayable through executorLabel. */ }
  return id;
}
export function traceCandidates(decision?: TraceDecision, task?: TaskDetail) {
  if (decision) return (decision.proposal?.choices ?? []).map(c => ({agent:candidateAgent(c.id), why:reasonCopy(c.reason), verdict:c.id===decision.selectedCandidateId?"Chosen":"Eligible", tone:c.id===decision.selectedCandidateId?"good" as const:"neutral" as const}));
  if (!task?.routing) return [];
  return [
    ...(task.routing.chosen ? [{agent:task.routing.chosen,why:reasonCopy(task.routing.why),verdict:"Chosen",tone:"good" as const}] : []),
    ...task.routing.skipped.map(c=>({agent:c.executor,why:reasonCopy(c.reason),verdict:"Skipped",tone:"warn" as const})),
  ];
}
export function traceSteps(task: TaskDetail, tree?: TraceTree): TraceStep[] {
  const nodes = tree?.nodes ?? [], root = nodes.find(n => n.taskId === task.id);
  const steps: TraceStep[] = [];
  const replacedRoutingTimes = new Set<number>();
  for (const node of nodes) for (const decision of node.decisions as TraceDecision[]) {
    const attempt = node.attempts[decision.attempt - 1];
    const chosen = decision.proposal?.choices?.find(c => c.id === decision.selectedCandidateId);
    const measured = attempt?.tokens;
    const at = attempt?.startedAt ?? (node.taskId === task.id && decision.attempt === node.attempts.length + 1 ? task.attemptStartedAt : null);
    if (node.taskId === task.id && at != null) replacedRoutingTimes.add(at);
    steps.push({ at: at ?? null,
      title: chosen ? `Routed to ${executorLabel(candidateAgent(chosen.id))}` : "Dispatch decision recorded",
      detail: `Attempt ${decision.attempt} · ${chosen ? reasonCopy(chosen.reason) : "— selection not recorded"}`,
      agents: chosen ? [candidateAgent(chosen.id)] : [],
      tokens: measured?.total == null ? "—" : `${measured.coverage === "partial" ? "≥ " : ""}${compactCount(measured.total)}` });
  }
  if (!root?.decisions.length) {
    // Preserve every historical attempt. task.routing alone describes only the latest selection.
    const recorded = (task.attempts ?? []).filter(a => a.routing).map(a => ({ at: a.startedAt, routing: a.routing! }));
    if (task.routing && task.attemptStartedAt != null && !recorded.some(r => r.at === task.attemptStartedAt)) recorded.push({at:task.attemptStartedAt,routing:task.routing});
    if (!recorded.length && task.routing) recorded.push({ at: task.attempts?.at(-1)?.startedAt ?? task.startedAt!, routing: task.routing });
    for (const {at,routing} of recorded) {
      if (at != null) replacedRoutingTimes.add(at);
      steps.push({ at: at ?? null,
        title: routing.chosen ? `Routed to ${executorLabel(routing.chosen)}` : "Dispatch decision recorded",
        detail: `${task.kind ? kindCopy(task.kind) : "— task kind"} · ${reasonCopy(routing.why)}`,
        agents: routing.chosen ? [routing.chosen] : [], tokens: "—" });
    }
  }
  steps.push(...timelineCopy(task.timeline)
    .filter(entry => !(entry.raw.startsWith("Routed to ") && replacedRoutingTimes.has(entry.at)))
    .map(entry => ({ at: entry.at, title: entry.text, detail: "Task activity", agents: [], tokens: "—" })));
  const children = nodes.filter(n => n.taskId !== task.id);
  const created = children.flatMap(c => c.createdAt == null ? [] : [c.createdAt]);
  if (children.length) steps.push({ at: created.length ? Math.min(...created) : null,
    title: `Delegated ${children.length} ${children.length===1?"subtask":"subtasks"}`, detail: "Each subtask's recorded agent and token usage",
    agents: [], tokens: "—", children });
  return steps.sort((a,b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}
export const childState = (node: TraceNode) => taskStatus(node);
export function childTokens(node: TraceNode): string {
  const measured=node.attempts.filter(a=>a.tokens?.total!=null);
  return measured.length ? `${measured.length<node.attempts.length || measured.some(a=>a.tokens?.coverage!=="measured")?"≥ ":""}${compactCount(measured.reduce((sum,a)=>sum+(a.tokens?.total??0),0))}` : "—";
}

/** The engine retains step ids, but not their configured ladder position. */
export function decisionCaption(decision?: TraceDecision, subtask?: number, routingRecorded = false): string {
  if (!decision) return routingRecorded ? "From the routing record; no dispatch decision was stored." : "No alternatives were recorded for this step.";
  const labels: Record<string,string> = {"capable-with-headroom":"capable with spare capacity","usable-fallback":"usable fallback"};
  const step=decision.proposal?.step;
  return `Subtask ${subtask ?? "—"} · ladder step — · ${step ? labels[step] ?? "recorded selection step" : "— selection step"}`;
}

/** Past events are complete; only the latest event can describe the current task state. */
export function traceStepState(task: TaskDetail, index: number, count: number) {
  if (index < count - 1) return {tone:"done",glyph:"✓",rail:true};
  if (task.state === "failed" || task.state === "limit" || task.acceptance?.state === "failed") return {tone:"failed",glyph:"✕",rail:false};
  if (task.state === "queued" || task.state === "stopped") return {tone:"neutral",glyph:String(index+1),rail:false};
  if (["running","needs_input"].includes(task.state) || task.state === "done" && !task.review && !task.resolved && !task.dismissed && !task.retriedBy) return {tone:"current",glyph:"◐",rail:false};
  if (task.state === "done") return {tone:"done",glyph:"✓",rail:false};
  return {tone:"neutral",glyph:String(index+1),rail:false};
}

/** Executor totals describe work performed, even when that runner also plans. */
export function executorTokenRole(agent: string, attempts: number, children: TraceNode[]): string {
  const subtasks = children.filter(child => child.attempts.some(attempt => runnerAgent(attempt.executor) === agent)).length;
  return subtasks ? `${subtasks} ${subtasks === 1 ? "subtask" : "subtasks"}` : `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
}
