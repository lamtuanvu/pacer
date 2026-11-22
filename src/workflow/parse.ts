// Loading a workflow file: YAML or JSON text in, a normalized WorkflowDef (or a
// salvageable one plus every shape error) out. Edge tuples like
// `[from, to, "when", { max_loops: 2 }]` are normalized to EdgeDef objects here, and
// `entry` defaults to the first key of `steps`.
import { parse as parseYaml } from "yaml";
import { checkWorkflowShape, isPlainObject, type WorkflowDef, type WorkflowError } from "./schema";

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Accepts tuple edges (`[from, to, when?, {max_loops}?]`) and object edges, and
 * normalizes both to EdgeDef-shaped mappings. Malformed edges pass through untouched
 * so the schema reports them at the right index. */
export function normalizeEdge(edge: unknown): unknown {
  if (Array.isArray(edge)) {
    const [from, to, third, fourth] = edge;
    const out: Record<string, unknown> = {};
    if (edge.length >= 1) out.from = from;
    if (edge.length >= 2) out.to = to;
    const options = isPlainObject(fourth) ? fourth : isPlainObject(third) ? third : undefined;
    const when = isPlainObject(third) ? undefined : third;
    if (when !== undefined) out.when = when;
    if (isPlainObject(options)) {
      const maxLoops = hasOwn(options, "max_loops") ? options.max_loops : hasOwn(options, "maxLoops") ? options.maxLoops : undefined;
      if (maxLoops !== undefined) out.maxLoops = maxLoops;
    }
    return out;
  }
  if (isPlainObject(edge) && hasOwn(edge, "max_loops") && !hasOwn(edge, "maxLoops")) {
    return { ...edge, maxLoops: edge.max_loops };
  }
  return edge;
}

function normalizeEntry(data: Record<string, unknown>): Record<string, unknown> {
  if (hasOwn(data, "entry")) return data;
  const steps = data.steps;
  if (isPlainObject(steps)) {
    const first = Object.keys(steps)[0];
    if (first !== undefined) return { ...data, entry: first };
  }
  return data;
}

/** The lenient definition kept alongside shape errors: normalized (so structural
 * validation can still run over it) but cast, with the raw step values inside. */
function salvageDef(data: Record<string, unknown>): WorkflowDef {
  const steps = isPlainObject(data.steps) ? data.steps : {};
  const entry = typeof data.entry === "string" ? data.entry : Object.keys(steps)[0] ?? "";
  return {
    id: typeof data.id === "string" ? data.id : "",
    version: typeof data.version === "number" ? data.version : 0,
    steps: steps as WorkflowDef["steps"],
    edges: (Array.isArray(data.edges) ? data.edges : []) as WorkflowDef["edges"],
    entry,
  };
}

/** Normalize object-form workflow sources the same way as YAML/JSON text (edge tuples, max_loops, entry). */
export function normalizeWorkflowObject(data: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeEntry(data);
  normalized.edges = Array.isArray(normalized.edges) ? normalized.edges.map(normalizeEdge) : normalized.edges;
  return normalized;
}

export function parseWorkflow(source: string): { def?: WorkflowDef; errors: WorkflowError[] } {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    return { errors: [{ path: "", message: `invalid YAML or JSON: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  if (!isPlainObject(data)) return { errors: [{ path: "", message: "workflow must be a mapping" }] };
  const normalized = normalizeWorkflowObject(data);
  const { def, errors } = checkWorkflowShape(normalized);
  if (def) return { def, errors: [] };
  return { def: salvageDef(normalized), errors };
}
