import { z } from "zod";
import { isVersion } from "../update/version";
import { observationMethodSchema, observationScopeSchema, observationSchema, decisionRequestSchema, proposalSchema } from "../dispatch/types";

/** Plugin protocol version; independent of the client protocol (P4 applies to both). */
export const PLUGIN_PROTOCOL_VERSION = "1.1.0";
export const PLUGIN_PROTOCOL_MAJOR = 1;

export const EXTENSION_POINTS = ["diagnostic", "agentSession", "observation", "decision"] as const;
export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

export const CAPABILITIES = ["tasks.read", "events.subscribe", "process.spawn", "fs.read", "net.http", "secrets.resolve", "config.get", "entitlement.report", "log"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_RANGE = /^(\^|~|>=)?\d+(\.\d+){0,2}$|^\*$/;

export const manifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID, "id is 2-64 lowercase letters, digits and hyphens"),
  version: z.string().refine(isVersion, "version is semver (MAJOR.MINOR.PATCH)"),
  publisher: z.string().min(1).max(128),
  host: z.string().regex(SEMVER_RANGE, "host is a semver range such as ^1 or ^1.2.0"),
  contributes: z.partialRecord(z.enum(EXTENSION_POINTS), z.record(z.string(), z.json())).default({}),
  capabilities: z.array(z.object({ name: z.enum(CAPABILITIES), scopes: z.array(z.string().min(1)).optional() })).default([]),
  entry: z.string().min(1).optional(),
  reentrant: z.boolean().default(false),
  tier: z.enum(["free", "commercial"]).default("free"),
});
export type PluginManifest = z.infer<typeof manifestSchema>;

export const HELLO_METHOD = "plugin.hello";
export const CANCEL_METHOD = "$/cancel";

export const helloParams = z.object({
  protocol: z.string(), pacer: z.string(), manifest: manifestSchema,
  config: z.record(z.string(), z.json()), grants: z.array(z.enum(CAPABILITIES)),
});
export const helloResult = z.object({ protocol: z.string(), id: z.string(), version: z.string(), contributes: z.array(z.string()) });
export type HelloResult = z.infer<typeof helloResult>;

export interface MethodDef<P extends z.ZodTypeAny = z.ZodTypeAny, R extends z.ZodTypeAny = z.ZodTypeAny> { description: string; params: P; result: R; deadlineMs: number }
const method = <P extends z.ZodTypeAny, R extends z.ZodTypeAny>(d: MethodDef<P, R>) => d as unknown as MethodDef;

const agentVersion = z.object({agent: z.string().min(1).max(64), version: z.string().min(1).max(128), help: z.string().max(100_000).optional(), resumeHelp: z.string().max(100_000).optional(), apiHelp: z.string().max(100_000).optional()});
const attachmentRef = z.object({id: z.string().min(1).max(128), name: z.string().max(255), mime: z.string().max(128), size: z.number().int().nonnegative(), path: z.string().min(1).max(4096)});
export const agentCapabilitiesResult = z.object({interactive: z.boolean(), resume: z.boolean(), launchImages: z.boolean(), liveImages: z.boolean(), files: z.boolean(), reason: z.string().optional()});
export const agentPrepareParams = agentVersion.extend({request: z.string().max(200_000), workspace: z.string().min(1), runDir: z.string().min(1), attachmentDir: z.string().min(1).optional(), attachments: z.array(attachmentRef).max(20), permissionPolicy: z.literal("native"), model: z.string().optional(), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), newSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional()});
export const agentLaunchResult = z.object({argv: z.array(z.string()).min(1), cwd: z.string().min(1), stdin: z.string().optional(), reporting: z.object({source: z.string().max(100_000), configEnv: z.enum(["OPENCODE_CONFIG_CONTENT"]), configKey: z.enum(["plugins"])}).optional()});
export const agentAttachmentParams = agentVersion.extend({workspace: z.string().min(1), attachment: attachmentRef, phase: z.enum(["launch", "live"])});
export const agentAttachmentResult = z.discriminatedUnion("kind", [z.object({kind: z.literal("native"), args: z.array(z.string())}), z.object({kind: z.literal("reference"), text: z.string(), requiresUserSubmit: z.literal(true)}), z.object({kind: z.literal("unsupported"), reason: z.string()})]);
export const delegationControlResult = z.discriminatedUnion("mechanism", [
  z.object({mechanism:z.literal("hook"),entryPoints:z.array(z.string().min(1).max(64)).min(1).max(8)}).strict(),
  z.object({mechanism:z.literal("permission"),entryPoints:z.array(z.string().min(1).max(64)).min(1).max(8),permissionAction:z.string().min(1).max(64)}).strict(),
  z.object({mechanism:z.literal("unsupported"),entryPoints:z.array(z.string()).length(0),reason:z.string().min(1).max(500)}).strict(),
]);

/** Host → plugin. Keys are `<extensionPoint>.<method>`; every plugin serves `diagnostic`. */
export const EXTENSION_METHODS: Record<string, MethodDef> = {
  "observation.observe": method({description:"Return normalized, scoped observations without credentials or raw provider payloads.",params:z.object({scope:observationScopeSchema,method:observationMethodSchema}),result:z.array(observationSchema).max(64),deadlineMs:5000}),
  "decision.decide": method({description:"Recommend ordered candidate IDs; the host validates and controls admission.",params:decisionRequestSchema,result:proposalSchema,deadlineMs:5000}),
  "agentSession.identity": method({description: "Plan native conversation identity allocation or explicit recovery without spawning.",
    params: agentVersion.extend({taskId: z.string().min(1).max(128), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), model: z.string().optional()}),
    result: z.discriminatedUnion("kind", [z.object({kind: z.literal("none")}), z.object({kind: z.literal("assigned"), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}),
      z.object({kind: z.literal("command"), argv: z.array(z.string()).min(1), idPath: z.array(z.string()).min(1).max(8)})]), deadlineMs: 5000}),
  "agentSession.capabilities": method({description: "Interactive agent capabilities for an installed version.", params: agentVersion, result: agentCapabilitiesResult, deadlineMs: 5000}),
  "agentSession.delegationControl": method({description: "Describe a candidate native subagent blocking path; the host must probe before certification.",params:agentVersion,result:delegationControlResult,deadlineMs:5000}),
  "agentSession.prepare": method({description: "Prepare an interactive argument vector without credentials or spawning.", params: agentPrepareParams, result: agentLaunchResult, deadlineMs: 5000}),
  "agentSession.attachment": method({description: "Prepare native attachment arguments or an explicit reference without submitting input.", params: agentAttachmentParams, result: agentAttachmentResult, deadlineMs: 5000}),
  "diagnostic.ping": method({ description: "Liveness check used by plugin.doctor.", params: z.object({}), result: z.object({ ok: z.literal(true), uptimeS: z.number().nonnegative() }), deadlineMs: 5000 }),
};

/** Plugin → host. Keys are `capability.<name>`; answered only when the manifest declares the capability. */
export const CAPABILITY_METHODS: Record<string, MethodDef> = {
  "capability.log": method({ description: "Append a line to the plugin's log file under PACER_HOME/logs/plugins.", params: z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string().max(4096) }), result: z.object({ ok: z.literal(true) }), deadlineMs: 1000 }),
  "capability.config.get": method({ description: "The plugin's own config slice (plugins.config.<id> in the strategy file).", params: z.object({}), result: z.object({ config: z.record(z.string(), z.json()) }), deadlineMs: 1000 }),
};

export function capabilityOf(method: string): Capability | null {
  if (!method.startsWith("capability.")) return null;
  const name = method.slice("capability.".length);
  return (CAPABILITIES as readonly string[]).includes(name) ? (name as Capability) : null;
}

export const PLUGIN_STATES = ["disabled", "refused", "needs_grant", "idle", "starting", "ready", "failing"] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];
