// The declarative workflow format: step types, edges and the top-level shape, as zod 4
// strict schemas plus the TypeScript types other modules consume. The frame fixes the
// vocabulary (agent, human, fanout, end); what the steps mean belongs to workflow files.
import { z } from "zod";

export interface JsonSchemaLite {
  required?: string[];
}

export interface AgentStep {
  type: "agent";
  /** Required for executor steps; optional when `role` is `orchestrator` or `reviewer`. */
  kind?: string;
  role?: "orchestrator" | "reviewer";
  interactive?: boolean;
  difficulty?: "simple" | "standard" | "complex";
  prompt: string;
  result?: JsonSchemaLite;
}

export interface HumanStep {
  type: "human";
  /** Defaults to `must` when omitted (zod parse fills it; object literals may omit it). */
  decision?: "must" | "auto";
  question: { text: string; kind: "single" | "text" | "yes_no" | "approve_revise"; options?: string[] };
}

export interface FanoutStep {
  type: "fanout";
  branches: string[];
  each: AgentStep;
  join: "all" | "any" | { quorum: number };
}

export interface ChooseWorkflowStep {
  type: "choose_workflow";
  from?: string[];
}

export interface GenerateLimits {
  step_types: ("agent" | "fanout" | "human")[];
  max_steps: number;
  /** Nesting depth ceiling for generated graphs; default 2 when omitted. */
  max_depth?: number;
  kinds?: string[];
  /** Keys are kind predicates (`kind in [a, b]` or a bare kind); value is always `reviewer`. */
  require_after?: Record<string, "reviewer">;
  require_last?: { kind: string };
}

export interface GenerateStep {
  type: "generate";
  role?: "orchestrator";
  prompt: string;
  limits: GenerateLimits;
  approval?: "must" | "auto";
  /** Failed validation attempts allowed before the step fails; default 2. */
  retries?: number;
}

export interface EndStep {
  type: "end";
}

export type StepDef = AgentStep | HumanStep | FanoutStep | ChooseWorkflowStep | GenerateStep | EndStep;

export interface EdgeDef {
  from: string;
  to: string;
  when?: string;
  maxLoops?: number;
}

/** Re-plan after a generated child step fails: auto N times then ask, or always ask. */
export type ReplanPolicy = { auto: number; then: "ask" } | "ask";

export interface WorkflowPolicy {
  budget?: { orchestrator_turns?: number; message_turns?: number };
  replan?: ReplanPolicy;
}

export interface WorkflowDef {
  id: string;
  version: number;
  title?: string;
  inputs?: Record<string, "string">;
  policy?: WorkflowPolicy;
  steps: Record<string, StepDef>;
  edges: EdgeDef[];
  entry: string;
}

export interface WorkflowError {
  path: string;
  message: string;
}

export const STEP_TYPES = ["agent", "human", "fanout", "choose_workflow", "generate", "end"] as const;
type StepType = (typeof STEP_TYPES)[number];

const jsonSchemaLite = z.strictObject({ required: z.array(z.string()).optional() });

/** Executor agent steps need `kind`; orchestrator and reviewer steps may omit it.
 *  `interactive` is only valid with `role: orchestrator` (checked in the refine below). */
const agentStepSchema = z.strictObject({
  type: z.literal("agent"),
  kind: z.string().min(1).optional(),
  role: z.enum(["orchestrator", "reviewer"]).optional(),
  interactive: z.boolean().optional(),
  difficulty: z.enum(["simple", "standard", "complex"]).optional(),
  prompt: z.string().min(1),
  result: jsonSchemaLite.optional(),
}).superRefine((value, ctx) => {
  if (value.interactive === true && value.role !== "orchestrator") {
    ctx.addIssue({ code: "custom", path: ["interactive"], message: "interactive is only valid with role: orchestrator" });
  }
  if (value.role !== "orchestrator" && value.role !== "reviewer" && (value.kind === undefined || value.kind.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["kind"], message: "kind is required for agent steps without role: orchestrator or reviewer" });
  }
});

const humanStepSchema = z.strictObject({
  type: z.literal("human"),
  decision: z.enum(["must", "auto"]).default("must"),
  question: z.strictObject({
    text: z.string().min(1),
    kind: z.enum(["single", "text", "yes_no", "approve_revise"]),
    options: z.array(z.string().min(1)).optional(),
  }),
});

/** Fan-out branches always run as executor agent steps (kind required). */
const fanoutEachSchema = z.strictObject({
  type: z.literal("agent"),
  kind: z.string().min(1),
  difficulty: z.enum(["simple", "standard", "complex"]).optional(),
  prompt: z.string().min(1),
  result: jsonSchemaLite.optional(),
});

const fanoutStepSchema = z.strictObject({
  type: z.literal("fanout"),
  branches: z.array(z.string().min(1)).min(1),
  each: fanoutEachSchema,
  join: z.union([z.literal("all"), z.literal("any"), z.strictObject({ quorum: z.number().int().min(1) })]),
});

const chooseWorkflowStepSchema = z.strictObject({
  type: z.literal("choose_workflow"),
  from: z.array(z.string().min(1)).optional(),
});

const generateLimitsSchema = z.strictObject({
  step_types: z.array(z.enum(["agent", "fanout", "human"])).min(1),
  max_steps: z.number().int().min(1),
  max_depth: z.number().int().min(1).optional(),
  kinds: z.array(z.string().min(1)).optional(),
  require_after: z.record(z.string(), z.literal("reviewer")).optional(),
  require_last: z.strictObject({ kind: z.string().min(1) }).optional(),
});

const generateStepSchema = z.strictObject({
  type: z.literal("generate"),
  role: z.literal("orchestrator").optional(),
  prompt: z.string().min(1),
  limits: generateLimitsSchema,
  approval: z.enum(["must", "auto"]).optional(),
  retries: z.number().int().min(0).optional(),
});

const endStepSchema = z.strictObject({ type: z.literal("end") });

const stepSchemas: Record<StepType, z.ZodType> = {
  agent: agentStepSchema,
  human: humanStepSchema,
  fanout: fanoutStepSchema,
  choose_workflow: chooseWorkflowStepSchema,
  generate: generateStepSchema,
  end: endStepSchema,
};

const replanPolicySchema = z.union([
  z.literal("ask"),
  z.strictObject({
    auto: z.number().int().min(0),
    then: z.literal("ask"),
  }),
]);

const workflowPolicySchema = z.strictObject({
  budget: z.strictObject({
    orchestrator_turns: z.number().int().min(1).optional(),
    message_turns: z.number().int().min(1).optional(),
  }).optional(),
  replan: replanPolicySchema.optional(),
});

export const edgeDefSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.string().min(1).optional(),
  maxLoops: z.number().int().min(1).optional(),
});

export const workflowDefSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().min(1),
  title: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.literal("string")).optional(),
  policy: workflowPolicySchema.optional(),
  steps: z.record(z.string(), z.unknown()),
  edges: z.array(z.unknown()),
  entry: z.string().min(1).optional(),
});

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Joins an issue path onto a prefix: `edges[0]` + `.to`, or `steps.a` + `.type`. */
function joinPath(prefix: string, seg: string): string {
  if (!prefix) return seg;
  if (!seg) return prefix;
  return seg.startsWith("[") ? prefix + seg : `${prefix}.${seg}`;
}

function pathToString(path: PropertyKey[]): string {
  return path.map(seg => typeof seg === "symbol" ? String(seg) : seg).reduce<string>((acc, seg) => {
    if (typeof seg === "number") return `${acc}[${seg}]`;
    if (acc === "") return seg;
    return `${acc}.${seg}`;
  }, "");
}

function issuesToErrors(prefix: string, error: z.ZodError): WorkflowError[] {
  const errors: WorkflowError[] = [];
  for (const issue of error.issues) {
    const path = joinPath(prefix, pathToString(issue.path));
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) errors.push({ path: joinPath(path, key), message: `unknown field '${key}'` });
      continue;
    }
    errors.push({ path, message: issue.message });
  }
  return errors;
}

/** One step's schema check. Steps are checked one by one so a bad `type` reports the
 * allowed values at `steps.<id>.type` instead of a bare union failure. */
export function stepErrors(id: string, value: unknown): WorkflowError[] {
  if (!isPlainObject(value)) return [{ path: `steps.${id}`, message: "step must be a mapping with a type" }];
  const type = value.type;
  if (typeof type !== "string" || !STEP_TYPES.includes(type as StepType)) {
    return [{ path: `steps.${id}.type`, message: `step types allowed are ${STEP_TYPES.join(", ")}` }];
  }
  const parsed = stepSchemas[type as StepType].safeParse(value);
  if (parsed.success) return [];
  return issuesToErrors(`steps.${id}`, parsed.error as z.ZodError);
}

/** Shape check for a whole workflow: zod on the top level, per-step checks on `steps`,
 * per-edge checks on `edges`. Collects every error and returns the typed definition
 * only when the shape is clean. */
export function checkWorkflowShape(data: unknown): { def?: WorkflowDef; errors: WorkflowError[] } {
  if (!isPlainObject(data)) return { errors: [{ path: "", message: "workflow must be a mapping" }] };
  const top = workflowDefSchema.safeParse(data);
  const errors: WorkflowError[] = top.success ? [] : issuesToErrors("", top.error as z.ZodError);
  const steps = isPlainObject(data.steps) ? data.steps : {};
  for (const [id, value] of Object.entries(steps)) errors.push(...stepErrors(id, value));
  const edges = Array.isArray(data.edges) ? data.edges : [];
  edges.forEach((edge, i) => {
    const prefix = `edges[${i}]`;
    if (!isPlainObject(edge)) {
      errors.push({ path: prefix, message: "edge must be a mapping" });
      return;
    }
    const parsed = edgeDefSchema.safeParse(edge);
    if (!parsed.success) errors.push(...issuesToErrors(prefix, parsed.error as z.ZodError));
  });
  if (errors.length > 0 || !top.success) return { errors };
  const clean = top.data;
  const def: WorkflowDef = {
    id: clean.id,
    version: clean.version,
    steps: Object.fromEntries(Object.entries(steps).map(([id, value]) => [id, stepSchemas[(value as { type: string }).type as StepType].parse(value)])) as Record<string, StepDef>,
    edges: edges.map(edge => edgeDefSchema.parse(edge)) as EdgeDef[],
    entry: clean.entry ?? Object.keys(steps)[0] ?? "",
  };
  if (clean.title !== undefined) def.title = clean.title;
  if (clean.inputs !== undefined) def.inputs = clean.inputs;
  if (clean.policy !== undefined) def.policy = clean.policy;
  return { def, errors: [] };
}
