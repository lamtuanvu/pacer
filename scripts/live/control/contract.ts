import type { OperationContext } from "./deadline";
import { z } from "zod";
import { captureMetadataSchema, type CaptureMetadata } from "../../../src/desktop/capture-contract";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16384;
export const MAX_ELEMENTS = 2000;
export const surfaceSchema = z.enum(["web", "tray", "desktop", "tui"]);
export type Surface = z.infer<typeof surfaceSchema>;
const boundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const capabilitySchema = z.enum(["inspect", "click", "type", "key", "scroll", "select", "resize", "activate", "capture"]);
export type Capability = z.infer<typeof capabilitySchema>;
export const targetSchema = z.object({
  id: z.string().min(1), surface: surfaceSchema, generation: z.string().min(1),
  capabilities: z.array(capabilitySchema), pid: z.number().int().positive().optional(),
  start_identity: z.string().optional(), window_id: z.string().optional(), client_id: z.string().optional(), bounds: boundsSchema.optional(), native_label: z.enum(["main", "tray"]).optional(),
});
export type Target = z.infer<typeof targetSchema>;
export const selectorSchema = z.object({ role: z.string().optional(), name: z.string().optional(), within: z.object({ role: z.string().optional(), name: z.string().optional() }).optional() }).strict()
  .refine(value => value.role !== undefined || value.name !== undefined, "selector requires role or name");
export type Selector = z.infer<typeof selectorSchema>;
export const actionSchema = z.object({
  kind: capabilitySchema.exclude(["inspect", "capture"]),
  selector: selectorSchema.optional(), ref: z.string().optional(), revision: z.string().optional(), generation: z.string().optional(),
  text: z.string().max(65536).optional(), key: z.string().max(128).optional(),
  width: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(), height: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
  x: z.number().finite().optional(), y: z.number().finite().optional(),
  delta_x: z.number().finite().optional(), delta_y: z.number().finite().optional(),
  capture_id: z.string().optional(), value: z.string().optional(),
}).strict().superRefine((action, ctx) => {
  const required = action.kind === "type" ? "text" : action.kind === "key" ? "key" : action.kind === "select" ? "value" : undefined;
  if (required && action[required] === undefined) ctx.addIssue({ code: "custom", message: `${action.kind} requires ${required}` });
  if (action.kind === "resize" && (!action.width || !action.height)) ctx.addIssue({ code: "custom", message: "resize requires width and height" });
  if (action.ref && (!action.revision || !action.generation)) ctx.addIssue({ code: "custom", message: "ref requires revision and generation" });
  if ((action.x !== undefined || action.y !== undefined) && (action.x === undefined || action.y === undefined || !action.capture_id)) ctx.addIssue({ code: "custom", message: "coordinates require x, y and capture_id" });
});
export type Action = z.infer<typeof actionSchema>;
export const conditionSchema = z.object({
  role: z.string().optional(), name: z.string().optional(), text: z.string().optional(),
  value: z.string().optional(), focused: z.boolean().optional(), absent: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "condition must not be empty");
export type Condition = z.infer<typeof conditionSchema>;
export const elementSchema = z.object({
  ref: z.string(), role: z.string(), name: z.string(), value: z.string().optional(),
  focused: z.boolean().optional(), disabled: z.boolean().optional(), sensitive: z.boolean().optional(),
  ancestors: z.array(z.object({ role: z.string(), name: z.string() })).optional(),
  actions: z.array(z.string()), bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
});
export type Element = z.infer<typeof elementSchema>;
export const observationSchema = z.object({
  target: targetSchema, revision: z.string(), elements: z.array(elementSchema).max(MAX_ELEMENTS),
  text: z.string().optional(), cursor: z.object({ x: z.number(), y: z.number() }).optional(), truncated: z.boolean(),
});
export type Observation = z.infer<typeof observationSchema>;
export type CaptureMode = "window" | "content";
export interface CaptureResult {
  method: "browser" | "window" | "content" | "external-window" | "terminal";
  bytes: Uint8Array; mime: "image/png" | "text/plain";
  width?: number; height?: number; scale?: number;
  producer?: CaptureMetadata;
  warnings?: Array<{ code: string; message: string }>;
}
export const artifactSchema = z.object({
  id: z.string(), path: z.string(), sha256: z.string(), method: z.string(), mime: z.string(), at: z.string(),
  width: z.number().optional(), height: z.number().optional(), scale: z.number().optional(), bounds: boundsSchema.optional(), producer: captureMetadataSchema.optional(),
});
export type Artifact = z.infer<typeof artifactSchema>;
export type Delivery = "delivered" | "not_delivered" | "unknown";
export interface ActionReceipt { delivery: Delivery }
export class ControlError extends Error {
  constructor(public code: string, message: string, public delivery?: Delivery) { super(`${code}: ${message}`); }
}
export const requestSchema = z.object({
  command: z.enum(["targets", "inspect", "act", "wait", "assert", "capture", "doctor"]),
  surface: surfaceSchema, target: z.string().default("main"), action: actionSchema.optional(), condition: conditionSchema.optional(),
  mode: z.enum(["window", "content"]).default("window"), timeout_ms: z.number().int().min(1).max(60000).default(10000),
}).strict().superRefine((request, ctx) => {
  if (request.command === "act" && !request.action) ctx.addIssue({ code: "custom", message: "act requires action" });
  if (["wait", "assert"].includes(request.command) && !request.condition) ctx.addIssue({ code: "custom", message: "condition required" });
});
export type ControlRequest = z.input<typeof requestSchema>;
export const resultSchema = z.object({
  schema_version: z.literal(1), run_id: z.string().optional(), command_id: z.string(), command: z.string(),
  started_at: z.string(), finished_at: z.string(), outcome: z.enum(["ok", "error"]),
  target: targetSchema.optional(), targets: z.array(targetSchema).optional(), observation: observationSchema.optional(),
  delivery: z.enum(["delivered", "not_delivered", "unknown"]).optional(),
  verdict: z.enum(["PASS", "FAIL", "UNVERIFIED"]).optional(), artifacts: z.array(artifactSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  provenance: z.object({ id: z.string(), path: z.string() }).optional(),
  request: z.record(z.string(), z.json()).optional(),
  diagnostics: z.record(z.string(), z.json()).optional(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
});
export type ControlResult = z.infer<typeof resultSchema>;
export function parseResult(value: unknown): ControlResult {
  if (typeof value !== "object" || value === null || !("schema_version" in value) || value.schema_version !== 1) {
    throw new ControlError("unsupported_schema", "expected result schema major 1");
  }
  return resultSchema.parse(value);
}
export interface SurfaceAdapter {
  targets(context?: OperationContext): Promise<Target[]>;
  inspect(target: Target, context?: OperationContext): Promise<Observation>;
  act(target: Target, action: Action, context?: OperationContext): Promise<ActionReceipt>;
  capture(target: Target, mode: CaptureMode, captureId?: string, context?: OperationContext): Promise<CaptureResult>;
  close(): Promise<void>;
}
export function resolveElement(observation: Observation, selector: Selector): Element {
  const elements = observation.elements.filter(element => (selector.role === undefined || element.role === selector.role) && (selector.name === undefined || element.name === selector.name) &&
    (!selector.within || element.ancestors?.some(ancestor => (selector.within!.role === undefined || ancestor.role === selector.within!.role) && (selector.within!.name === undefined || ancestor.name === selector.within!.name))));
  if (elements.length > 1) throw new ControlError("ambiguous", "selector matches multiple controls");
  if (!elements.length) throw new ControlError(observation.truncated ? "inconclusive" : "not_found", "control not observed");
  return elements[0];
}
