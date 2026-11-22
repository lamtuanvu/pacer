// Static validation of a workflow definition, on top of the shape checks: edges must
// point at existing steps, `when` clauses must parse, an `end` must be reachable from
// the entry, and every back edge must declare `maxLoops`. All errors are reported at
// once; nothing is stored when any of them fires (spec, Review Focus 2).
import { parseCondition } from "./condition";
import { checkWorkflowShape, isPlainObject, type EdgeDef, type WorkflowDef, type WorkflowError } from "./schema";

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

interface Candidate {
  edge: EdgeDef;
  index: number;
}

/** Edges usable for endpoint and `when` checks: plain mappings with string endpoints.
 * Existence of the named steps is not required here; that is exactly what we report. */
function candidateEdges(edges: unknown[]): Candidate[] {
  const out: Candidate[] = [];
  edges.forEach((raw, index) => {
    if (!isPlainObject(raw)) return;
    const edge = raw as { from?: unknown; to?: unknown; when?: unknown };
    if (typeof edge.from !== "string" || typeof edge.to !== "string") return;
    out.push({ edge: edge as EdgeDef, index });
  });
  return out;
}

function isEndStep(steps: Record<string, unknown>, id: string): boolean {
  const step = steps[id];
  return isPlainObject(step) && step.type === "end";
}

/** Depth-first search over usable edges, successors in edge order: an edge is a back
 * edge when its target is on the DFS stack at the moment it is followed, so only the
 * edge that closes a loop is classified, not every edge inside it (self-loops count).
 * The search starts at `entry` and continues from every step it did not visit, in
 * step order, so loops unreachable from the entry are classified too. */
function adjacencyOf(def: WorkflowDef): {
  names: Set<string>;
  adjacency: Map<string, { to: string; index: number }[]>;
} {
  const names = new Set(Object.keys(isPlainObject(def.steps) ? def.steps : {}));
  const adjacency = new Map<string, { to: string; index: number }[]>();
  (Array.isArray(def.edges) ? def.edges : []).forEach((edge, index) => {
    if (typeof edge?.from !== "string" || typeof edge?.to !== "string") return;
    if (!names.has(edge.from) || !names.has(edge.to)) return;
    const list = adjacency.get(edge.from) ?? [];
    list.push({ to: edge.to, index });
    adjacency.set(edge.from, list);
  });
  return { names, adjacency };
}

export function backEdgeIndexes(def: WorkflowDef): Set<number> {
  return new Set(backEdgeCycles(def).map(c => c.index));
}

/** Back edges with the nodes on the cycle each closes (DFS stack slice). */
export function backEdgeCycles(def: WorkflowDef): { index: number; cycle: Set<string> }[] {
  const { names, adjacency } = adjacencyOf(def);
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();
  const out: { index: number; cycle: Set<string> }[] = [];
  const visit = (node: string): void => {
    stack.push(node);
    onStack.add(node);
    for (const { to, index } of adjacency.get(node) ?? []) {
      if (onStack.has(to)) {
        const start = stack.indexOf(to);
        out.push({ index, cycle: new Set(stack.slice(start)) });
      } else if (!visited.has(to)) visit(to);
    }
    stack.pop();
    onStack.delete(node);
    visited.add(node);
  };
  const entry = typeof def.entry === "string" && names.has(def.entry) ? def.entry : undefined;
  if (entry !== undefined) visit(entry);
  for (const name of names) if (!visited.has(name)) visit(name);
  return out;
}

/** Work units for one step: fanout counts as its branch count; others (incl. generate) as 1. */
function stepWorkUnits(def: WorkflowDef, id: string): number {
  const step = def.steps[id];
  if (!step || step.type === "end") return 0;
  if (step.type === "fanout") return Math.max(1, step.branches?.length ?? 1);
  return 1;
}

/**
 * Uncapped descendant budget: every non-end step once, plus
 * sum(maxLoops_e * |cycle_e work units|) for each back edge, plus retries slack.
 * Callers clamp to the schema max (1000) when sizing a root.
 */
export function estimateDescendantBudget(def: WorkflowDef): number {
  let base = 0;
  for (const id of Object.keys(def.steps ?? {})) base += stepWorkUnits(def, id);
  let loopExtra = 0;
  for (const { index, cycle } of backEdgeCycles(def)) {
    const edge = Array.isArray(def.edges) ? def.edges[index] : undefined;
    const maxLoops = typeof edge?.maxLoops === "number" && Number.isFinite(edge.maxLoops) ? edge.maxLoops : 0;
    let cycleUnits = 0;
    for (const id of cycle) cycleUnits += stepWorkUnits(def, id);
    loopExtra += maxLoops * cycleUnits;
  }
  const retriesSlack = Math.max(10, Object.keys(def.steps ?? {}).length);
  return base + loopExtra + retriesSlack;
}

/** Work-unit estimate without retries slack (generated max_steps / limits checks). */
export function estimateWorkUnits(def: WorkflowDef): number {
  let base = 0;
  for (const id of Object.keys(def.steps ?? {})) base += stepWorkUnits(def, id);
  let loopExtra = 0;
  for (const { index, cycle } of backEdgeCycles(def)) {
    const edge = Array.isArray(def.edges) ? def.edges[index] : undefined;
    const maxLoops = typeof edge?.maxLoops === "number" && Number.isFinite(edge.maxLoops) ? edge.maxLoops : 0;
    let cycleUnits = 0;
    for (const id of cycle) cycleUnits += stepWorkUnits(def, id);
    loopExtra += maxLoops * cycleUnits;
  }
  return base + loopExtra;
}

export function validateWorkflow(def: WorkflowDef): WorkflowError[] {
  const errors: WorkflowError[] = checkWorkflowShape(def).errors;
  const steps = isPlainObject(def.steps) ? (def.steps as unknown as Record<string, unknown>) : {};
  const edges = Array.isArray(def.edges) ? def.edges : [];
  const candidates = candidateEdges(edges);

  for (const { edge, index } of candidates) {
    for (const field of ["from", "to"] as const) {
      const name = edge[field];
      if (typeof name === "string" && !hasOwn(steps, name)) errors.push({ path: `edges[${index}].${field}`, message: `unknown step '${name}'` });
    }
    if (typeof edge.when !== "string") continue;
    const { error } = parseCondition(edge.when);
    if (error) errors.push({ path: `edges[${index}].when`, message: error });
  }

  const names = Object.keys(steps);
  if (names.length === 0) {
    errors.push({ path: "steps", message: "a workflow needs at least one step" });
    return errors;
  }
  const entry = typeof def.entry === "string" && hasOwn(steps, def.entry) ? def.entry : names[0];
  if (typeof def.entry === "string" && def.entry !== "" && !hasOwn(steps, def.entry)) {
    errors.push({ path: "entry", message: `unknown step '${def.entry}'` });
  }

  // Step ids and fan-out branch names go into delegate request ids (128 characters
  // with the run id, attempt and separators), so they are capped at 48 characters.
  // Fan-out joins must be consistent with their branches, and every step that runs
  // must be able to leave.
  for (const [id, value] of Object.entries(steps)) {
    if (id.length > 48) errors.push({ path: `steps.${id}`, message: `step id '${id}' is longer than 48 characters` });
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      errors.push({ path: `steps.${id}`, message: `step id '${id}' must match ^[A-Za-z0-9_-]+$` });
    }
    if (!isPlainObject(value)) continue;
    const rawBranches = Array.isArray(value.branches) ? value.branches : [];
    if (value.type === "fanout") {
      const seen = new Set<string>();
      let named = 0;
      rawBranches.forEach((branch, index) => {
        if (typeof branch !== "string") return;
        named++;
        if (branch.length > 48) errors.push({ path: `steps.${id}.branches[${index}]`, message: `branch name '${branch}' is longer than 48 characters` });
        if (seen.has(branch)) errors.push({ path: `steps.${id}.branches[${index}]`, message: `duplicate branch name '${branch}'` });
        seen.add(branch);
      });
      const join = value.join;
      if (named > 0 && isPlainObject(join) && typeof join.quorum === "number" && join.quorum > named) {
        errors.push({ path: `steps.${id}.join`, message: `join quorum ${join.quorum} is greater than the branch count ${named}` });
      }
    }
    if (value.type !== "end" && !candidates.some(c => c.edge.from === id)) {
      errors.push({ path: `steps.${id}`, message: `step ${id} has no outgoing edge` });
    }
    if (value.type === "choose_workflow") {
      const outgoing = candidates.filter(c => c.edge.from === id).length;
      if (outgoing !== 1) {
        errors.push({ path: `steps.${id}`, message: `choose_workflow step ${id} must have exactly one outgoing edge` });
      }
    }
    // Publishing approval is person-only: approves: publish requires decision: must (D5)
    // and a yes_no / approve_revise question so answers are exactly approve/yes (R2-F6).
    if (value.type === "human" && value.approves === "publish") {
      const decision = value.decision === undefined ? "must" : value.decision;
      if (decision !== "must") {
        errors.push({ path: `steps.${id}.approves`, message: "approves: publish requires decision: must" });
      }
      const kind = value.question?.kind;
      if (kind !== "yes_no" && kind !== "approve_revise") {
        errors.push({
          path: `steps.${id}.question.kind`,
          message: "approves: publish requires question.kind yes_no or approve_revise",
        });
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const { edge } of candidates) {
    if (!hasOwn(steps, edge.from) || !hasOwn(steps, edge.to)) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const reachable = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  if (![...reachable].some(id => isEndStep(steps, id))) {
    errors.push({ path: "steps", message: `no end step is reachable from '${entry}'` });
  }

  for (const index of backEdgeIndexes(def)) {
    const edge = candidates.find(c => c.index === index);
    if (!edge) continue;
    if (typeof edge.edge.maxLoops !== "number" || !Number.isInteger(edge.edge.maxLoops) || edge.edge.maxLoops < 1) {
      errors.push({ path: `edges[${index}]`, message: "back edge needs max_loops" });
    }
  }

  const descendantEstimate = estimateDescendantBudget(def);
  if (descendantEstimate > 1000) {
    errors.push({
      path: "steps",
      message: `descendant budget estimate ${descendantEstimate} exceeds cap 1000`,
    });
  }

  return errors;
}
