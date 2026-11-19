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

/** Can `start` reach `target` following edges (conditions ignored)? A step reaches
 * itself, so a self-loop is a back edge. */
function reaches(adjacency: Map<string, string[]>, start: string, target: string): boolean {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === target) return true;
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function isEndStep(steps: Record<string, unknown>, id: string): boolean {
  const step = steps[id];
  return isPlainObject(step) && step.type === "end";
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

  for (const { edge, index } of candidates) {
    if (!hasOwn(steps, edge.from) || !hasOwn(steps, edge.to)) continue;
    if (!reaches(adjacency, edge.to, edge.from)) continue;
    if (typeof edge.maxLoops !== "number" || !Number.isInteger(edge.maxLoops) || edge.maxLoops < 1) {
      errors.push({ path: `edges[${index}]`, message: "back edge needs max_loops" });
    }
  }

  return errors;
}
