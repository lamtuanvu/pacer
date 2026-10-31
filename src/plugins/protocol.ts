import {POLICY_METHODS,POLICY_CAPABILITY_METHODS,POLICY_METHOD_CAPABILITY} from "./policy-protocol";
import {HOST_RUNNER_METHODS,hostRunnerContribution,hostRunnerStreamId} from "./host-runner-protocol";
import { EXECUTOR_METHODS, executorContribution } from "./executor-protocol";
import { HOSTS_METHODS, HOSTS_METHOD_CAPABILITY } from "./hosts-protocol";
import { REMOTE_CALLER_METHODS } from "./remote-caller-protocol";
export {HOST_RUNNER_SCRIPTS,hostRunnerAlias,hostRunnerSession,hostRunnerScript,hostRunnerContribution} from "./host-runner-protocol";
export { executorContribution, executorAvailableParams, executorAvailableResult } from "./executor-protocol";
export {POLICY_DECISIONS,POLICY_EVENT_TYPES,POLICY_TASK_STATES,POLICY_OBSERVATIONS_FEATURE,pluginMetadata,readOwnerMetadata,policyBeforeParams,policyVerdict,policyEvent} from "./policy-protocol";
import { z } from "zod";
import { PLANNER_METHODS, PLANNER_CAPABILITY_METHODS, PLANNER_METHOD_CAPABILITY } from "./planner-protocol";
import { SCOPED_CAPABILITY_METHODS, SCOPED_METHOD_CAPABILITY } from "./capability-protocol";
import { usageReadParams, usageReading } from "./usage-protocol";
export { usageReadParams, usageReading, usageAccount, usageWindow, callMetadata, type UsageReadParams } from "./usage-protocol";
import { ENDPOINT_METHODS } from "./endpoint-protocol";
import { FS_WRITE_METHODS, FS_WRITE_METHOD_CAPABILITY } from "./write-protocol";
export { endpointAccount, endpointState, discoveredModel, discoveryResult } from "./endpoint-protocol";
export { FILE_WRITE_CHUNK_FEATURE, FILE_WRITE_MAX_BYTES, FILE_WRITE_CHUNK_BYTES } from "./write-protocol";
import { NOTIFIER_METHODS } from "./notifier-protocol";
export { notificationMessage, notificationResult } from "./notifier-protocol";
import { CLASSIFIER_METHODS } from "./classifier-protocol";
import { HTTP_CAPABILITY_METHODS, HTTP_METHOD_CAPABILITY, secretReference } from "./http-protocol";
export { questionSchema, answerSchema, classifierAdapterConfig, classifierAskParams, type ClassifierQuestion, type ClassifierAnswer, type ClassifierAskParams } from "./classifier-protocol";
export { HTTP_BODY_CHUNK_FEATURE, HTTP_BODY_MAX_BYTES, HTTP_BODY_CHUNK_BYTES, httpRequest, httpResponse, httpBodyReference, secretReference, type HttpWireRequest, type HttpWireResponse } from "./http-protocol";
import { compareVersions, isVersion } from "../update/version";
import { type UiContribution, uiActionParams, uiActionResult, uiContributionSchema, uiRenderParams, uiRenderResult, uiValidateParams, uiValidateResult } from "./ui-schema";

export * from "./ui-schema";
import { observationMethodSchema, observationScopeSchema, observationSchema, decisionRequestSchema, proposalSchema } from "../dispatch/types";

/** Plugin protocol version; independent of the client protocol (P4 applies to both). */
export const PLUGIN_PROTOCOL_VERSION = "1.8.0";
/** Release that added the #503 policy redaction metadata and `kind:name` secret references. */
export const PLUGIN_HARDENING_PROTOCOL_VERSION = "1.8.0";
export const PLUGIN_PROTOCOL_MAJOR = 1;

export const EXTENSION_POINTS = ["diagnostic", "agentSession", "observation", "decision", "ui", "assistant", "pairing", "usage", "classifier", "notifier", "endpoint", "planner", "policy", "hostRunner", "remoteCaller", "executor"] as const;
export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

export const CAPABILITIES = ["tasks.read", "events.subscribe", "process.spawn", "fs.read", "net.http", "secrets.resolve", "config.get", "entitlement.report", "log", "identity.sign", "net.p2p", "fs.write", "usage.state", "hosts"] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** Extension points and capabilities added in 1.6.0; a manifest that uses one gates on that host. */
export const M0_EXTENSION_POINTS = ["usage", "classifier", "notifier", "endpoint", "planner", "policy"] as const satisfies readonly ExtensionPoint[];
export const M0_CAPABILITIES = ["fs.write", "usage.state"] as const satisfies readonly Capability[];
/** Extension points and capabilities added in 1.7.0 for SSH host runners; a manifest that uses one gates on that host. */
export const HOSTS_EXTENSION_POINTS = ["hostRunner", "remoteCaller", "executor"] as const satisfies readonly ExtensionPoint[];
export const HOSTS_CAPABILITIES = ["hosts"] as const satisfies readonly Capability[];

export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** Host signatures use this plugin id in the signing domain, so no plugin may claim it. */
export const RESERVED_PLUGIN_IDS = ["pacer"] as const;
const SEMVER_RANGE = /^(\^|~|>=)?\d+(\.\d+){0,2}$|^\*$/;
const genericContribution = z.record(z.string(), z.json());
/** Keep the published manifest schema as strict as runtime validation. */
export const manifestContributes = z.object({
  diagnostic: genericContribution.optional(),
  agentSession: genericContribution.optional(),
  observation: genericContribution.optional(),
  decision: genericContribution.optional(),
  ui: genericContribution.optional(),
  assistant: genericContribution.optional(),
  pairing: genericContribution.optional(),
  usage: genericContribution.optional(),
  classifier: genericContribution.optional(),
  notifier: genericContribution.optional(),
  endpoint: genericContribution.optional(),
  planner: genericContribution.optional(),
  policy: genericContribution.optional(),
  hostRunner: hostRunnerContribution.optional(),
  remoteCaller: genericContribution.optional(),
  executor: executorContribution.optional(),
}).strict();

export const manifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID, "id is 2-64 lowercase letters, digits and hyphens").refine(id => !(RESERVED_PLUGIN_IDS as readonly string[]).includes(id), { error: issue => `plugin id ${String(issue.input)} is reserved` }),
  version: z.string().refine(isVersion, "version is semver (MAJOR.MINOR.PATCH)"),
  publisher: z.string().min(1).max(128),
  host: z.string().regex(SEMVER_RANGE, "host is a semver range such as ^1 or ^1.2.0"),
  contributes: manifestContributes.default({}),
  capabilities: z.array(z.object({ name: z.enum(CAPABILITIES), scopes: z.array(z.string().min(1)).optional() })).default([]),
  entry: z.string().min(1).optional(),
  reentrant: z.boolean().default(false),
  tier: z.enum(["free", "commercial"]).default("free"),
}).superRefine((m, ctx) => {
  const extraction = M0_EXTENSION_POINTS.filter(point => m.contributes[point] !== undefined);
  const effects = m.capabilities.filter(c => (M0_CAPABILITIES as readonly string[]).includes(c.name)).map(c => c.name);
  if ((extraction.length || effects.length) && !hostFloorAtLeast(m.host, "1.6.0")) ctx.addIssue({ code: "custom", path: ["host"], message: `a manifest with ${[...extraction, ...effects].join(", ")} sets host to >=1.6.0` });
  const hostRunners = HOSTS_EXTENSION_POINTS.filter(point => m.contributes[point] !== undefined);
  const hostGrants = m.capabilities.filter(c => (HOSTS_CAPABILITIES as readonly string[]).includes(c.name)).map(c => c.name);
  if ((hostRunners.length || hostGrants.length) && !hostFloorAtLeast(m.host, "1.7.0")) ctx.addIssue({ code: "custom", path: ["host"], message: `a manifest with ${[...hostRunners, ...hostGrants].join(", ")} sets host to >=1.7.0` });
  if (m.capabilities.some(c => c.name === "identity.sign") && !hostFloorAtLeast(m.host, "1.4.0")) ctx.addIssue({ code: "custom", path: ["host"], message: "a manifest with the identity.sign capability sets host to >=1.4.0" });
  if (Object.hasOwn(m.contributes, "pairing")) {
    if (!m.capabilities.some(c => c.name === "net.p2p")) ctx.addIssue({ code: "custom", path: ["capabilities"], message: "a manifest with contributes.pairing declares net.p2p" });
    if (!hostFloorAtLeast(m.host, "1.5.0")) ctx.addIssue({ code: "custom", path: ["host"], message: "a manifest with contributes.pairing sets host to >=1.5.0" });
  }
  m.capabilities.forEach((c, i) => {
    if (c.name === "identity.sign") (c.scopes ?? []).forEach((scope, j) => {
      if (!PLUGIN_ID.test(scope)) ctx.addIssue({ code: "custom", path: ["capabilities", i, "scopes", j], message: "identity.sign scopes are signing purposes: 2-64 lowercase letters, digits and hyphens" });
    });
  });
  const raw = m.contributes.ui;
  if (raw === undefined) return;
  const ui = uiContributionSchema.safeParse(raw);
  if (!ui.success) { for (const i of ui.error.issues) ctx.addIssue({ code: "custom", path: ["contributes", "ui", ...i.path], message: i.message }); return; }
  if (!hostFloorAtLeast(m.host, "1.2.0")) ctx.addIssue({ code: "custom", path: ["host"], message: "a manifest with contributes.ui sets host to >=1.2.0" });
  if (ui.data.settings.length && !m.capabilities.some(c => c.name === "config.get")) ctx.addIssue({ code: "custom", path: ["capabilities"], message: "a plugin with a settings page declares the config.get capability" });
});
/** Whether the lowest version a host range accepts is at least `min`. */
function hostFloorAtLeast(host: string, min: string): boolean {
  const floor = /^(?:>=|\^|~)?(\d+(?:\.\d+){0,2})$/.exec(host)?.[1];
  const [a = "0", b = "0", c = "0"] = (floor ?? "0").split(".");
  return host !== "*" && compareVersions(`${a}.${b}.${c}`, min) >= 0;
}
/** The validated `contributes.ui`, with defaults, or null when the plugin contributes none. */
export function uiOf(m: Pick<PluginManifest, "contributes">): UiContribution | null {
  const raw = m.contributes.ui;
  return raw === undefined ? null : uiContributionSchema.parse(raw);
}
export type PluginManifest = z.infer<typeof manifestSchema>;

export const HELLO_METHOD = "plugin.hello";
export const CANCEL_METHOD = "$/cancel";

/** Negotiated transport, never a grant: each chunk belongs to an existing usage request or negotiated planner.install request. */
export const RESULT_CHUNK_METHOD = "$/resultChunk";
export const RESULT_CHUNK_FEATURE = "chunkedResults";
export const resultChunkParams = z.object({ request: z.number().int().positive().safe(), offset: z.number().int().nonnegative().safe(),
  base64: z.string().max(349528).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict();
export const resultChunkAck = z.object({ bytes: z.number().int().nonnegative().safe() }).strict();
export const chunkedResult = z.object({ _chunkedResult: z.object({ bytes: z.number().int().nonnegative().safe() }).strict() }).strict();

/** Private stream transport, scoped to the exact pending hostRunner.stream request. */
export const STREAM_ACK_METHOD = "$/streamAck";
export const streamProgressEvent = z.object({ streamId: hostRunnerStreamId, seq: z.number().int().nonnegative().safe(),
  base64: z.string().min(4).max(87_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict();
export const streamAckParams = z.object({ request: z.number().int().positive().safe(), streamId: hostRunnerStreamId,
  seq: z.number().int().nonnegative().safe() }).strict();
export const streamAckResult = z.object({ seq: z.number().int().nonnegative().safe() }).strict();
export const STREAM_INPUT_METHOD = "$/streamInput";
export const STREAM_INPUT_ACK_METHOD = "$/streamInputAck";
export const streamInputFrame = streamProgressEvent.extend({ request: z.number().int().positive().safe() }).strict();
export const streamInputAckParams = streamAckParams;
export const streamInputAckResult = streamAckResult;

export const helloParams = z.object({
  protocol: z.string(), pacer: z.string(), manifest: manifestSchema, features: z.array(z.string().min(1).max(64)).max(16).optional(),
  config: z.record(z.string(), z.json()), grants: z.array(z.enum(CAPABILITIES)),
});
export const helloResult = z.object({ features: z.array(z.string().min(1).max(64)).max(16).optional(), protocol: z.string(), id: z.string(), version: z.string(), contributes: z.array(z.string()) });
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


const assistantMessage = z.object({ role: z.enum(["user", "assistant", "tool"]), content: z.string().max(200_000), toolCallId: z.string().max(128).optional(), toolCalls: z.array(z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) })).max(16).optional() });
export const assistantRespondParams = z.object({
  conversationId: z.string().min(1).max(128), turnId: z.string().min(1).max(128), messages: z.array(assistantMessage).min(1).max(100),
  tools: z.array(z.object({ name: z.string().min(1).max(64), description: z.string().max(1000), parameters: z.unknown() })).max(32),
  context: z.object({ system: z.string().max(50_000), backend: z.object({ kind: z.literal("endpoint"), account: z.string().min(1).max(64), model: z.string().min(1).max(256), baseUrl: z.string().max(2048) }) }),
  limits: z.object({ maxOutputTokens: z.number().int().positive().max(32_000), maxToolRounds: z.number().int().min(0).max(6), deadlineMs: z.number().int().min(1000).max(120_000) }),
});
export const assistantRespondResult = z.object({
  message: z.string().max(200_000), toolCalls: z.array(z.object({ id: z.string().min(1).max(128), name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()) })).max(16).optional(),
  usage: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cacheRead: z.number().int().nonnegative().optional(), cacheWrite: z.number().int().nonnegative().optional(), coverage: z.enum(["measured", "partial", "unknown"]) }),
});
/** The host caps an `assistant.respond` call at this long, whatever `limits.deadlineMs` asks for. */
export const ASSISTANT_MAX_DEADLINE_MS = 120_000;

export const pairingStartResult = z.object({ accepted: z.boolean() });

/** Host → plugin. Keys are `<extensionPoint>.<method>`; every plugin serves `diagnostic`. */
export const EXTENSION_METHODS: Record<string, MethodDef> = {
  "observation.observe": method({description:"Return normalized, scoped observations without credentials or raw provider payloads.",params:z.object({scope:observationScopeSchema,method:observationMethodSchema}),result:z.array(observationSchema).max(64),deadlineMs:5000}),
  "decision.decide": method({description:"Recommend ordered candidate IDs; the host validates and controls admission.",params:decisionRequestSchema,result:proposalSchema,deadlineMs:5000}),
  "agentSession.identity": method({description: "Plan native conversation identity allocation or explicit recovery without spawning.",
    params: agentVersion.extend({taskId: z.string().min(1).max(128), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), model: z.string().optional()}),
    result: z.discriminatedUnion("kind", [z.object({kind: z.literal("none")}), z.object({kind: z.literal("assigned"), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}),
      z.object({kind: z.literal("command"), argv: z.array(z.string()).min(1), idPath: z.array(z.string()).min(1).max(8)})]), deadlineMs: 5000}),
  ...PLANNER_METHODS,
  ...POLICY_METHODS,
  ...HOST_RUNNER_METHODS,
  ...REMOTE_CALLER_METHODS,
  ...EXECUTOR_METHODS,
  ...CLASSIFIER_METHODS,
  ...NOTIFIER_METHODS,
  ...ENDPOINT_METHODS,
  "usage.read": method({ description: "Read a provider usage observation with host-derived account authority; cache clocks and rich evidence are preserved.", params: usageReadParams, result: usageReading, deadlineMs: 10000 }),
  "agentSession.capabilities": method({description: "Interactive agent capabilities for an installed version.", params: agentVersion, result: agentCapabilitiesResult, deadlineMs: 5000}),
  "agentSession.delegationControl": method({description: "Describe a candidate native subagent blocking path; the host must probe before certification.",params:agentVersion,result:delegationControlResult,deadlineMs:5000}),
  "agentSession.prepare": method({description: "Prepare an interactive argument vector without credentials or spawning.", params: agentPrepareParams, result: agentLaunchResult, deadlineMs: 5000}),
  "agentSession.attachment": method({description: "Prepare native attachment arguments or an explicit reference without submitting input.", params: agentAttachmentParams, result: agentAttachmentResult, deadlineMs: 5000}),
  "assistant.respond": method({description: "Answer one assistant turn from the messages and tool results the host provides. The host runs every read tool and calls again with the results, up to maxToolRounds. A returned toolCall is a request, not an action.", params: assistantRespondParams, result: assistantRespondResult, deadlineMs: ASSISTANT_MAX_DEADLINE_MS}),
  "ui.render": method({description:"Return the view document for one surface.",params:uiRenderParams,result:uiRenderResult,deadlineMs:2000}),
  "ui.action": method({description:"Handle a user action on a surface; the host has already shown any confirmation.",params:uiActionParams,result:uiActionResult,deadlineMs:10000}),
  "ui.settings.validate": method({description:"Check settings values the host already validated against the manifest schema.",params:uiValidateParams,result:uiValidateResult,deadlineMs:2000}),
  "pairing.start": method({
    description: "The user chose Pair for a machine found on the LAN. Start the plugin's pairing flow and say whether it took the request. The values come from the network: they are untrusted and already sanitized by the host. Never build URLs or commands from them. The host validates the result; an invalid result or an error counts as not accepted.",
    params: z.object({ discoveryId: z.string().regex(/^[a-z2-7]{26}$/), name: z.string().max(64), hints: z.string().max(200) }),
    result: pairingStartResult,
    deadlineMs: 5000,
  }),
  "diagnostic.ping": method({ description: "Liveness check used by plugin.doctor.", params: z.object({}), result: z.object({ ok: z.literal(true), uptimeS: z.number().nonnegative() }), deadlineMs: 5000 }),
};

/** Plugin → host. Keys are `capability.<name>`; answered only when the manifest declares the capability. */
export const CAPABILITY_METHODS: Record<string, MethodDef> = {
  ...HOSTS_METHODS,
  ...PLANNER_CAPABILITY_METHODS,
  ...POLICY_CAPABILITY_METHODS,
  ...SCOPED_CAPABILITY_METHODS,
  ...FS_WRITE_METHODS,
  ...HTTP_CAPABILITY_METHODS,
  "capability.log": method({ description: "Append a line to the plugin's log file under PACER_HOME/logs/plugins.", params: z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string().max(4096) }), result: z.object({ ok: z.literal(true) }), deadlineMs: 1000 }),
  "capability.secrets.resolve": method({ description: "Resolve the key of the endpoint account the user chose for the assistant. endpoint/<id> remains accepted for compatibility.", params: z.object({ ref: secretReference }), result: z.object({ value: z.string().nullable() }), deadlineMs: 5000 }),
  "capability.config.get": method({ description: "The plugin's own config slice (plugins.config.<id> in the strategy file).", params: z.object({}), result: z.object({ config: z.record(z.string(), z.json()) }), deadlineMs: 1000 }),
  "capability.identity.sign": method({
    description: "Sign a payload with this machine's key under the domain-separated format \"pacer-machine-sig/v1\" 0x00 plugin_id 0x00 purpose 0x00 payload. purpose must be declared in the manifest scopes for identity.sign. The transport-key purpose requires the payload \"transport-key/v1\" 0x00 followed by a 32-byte key and records it as the plugin's current transport key. payload and signature are base64. Refused with capability_denied while the home looks copied from another machine, until the user rotates the machine key. Every signature is recorded in the host-owned identity audit log. Refusals are recorded there too, at most 10 per minute per plugin; the next refusal in that minute writes one summary line and the rest are counted, not logged.",
    params: z.object({ purpose: z.string().regex(PLUGIN_ID), payload: z.string().max(87384).regex(/^[A-Za-z0-9+/]*={0,2}$/, "payload is base64").refine(isCanonicalBase64, "payload is canonical base64") }),
    result: z.object({ signature: z.string(), machineId: z.string() }),
    deadlineMs: 15000,
  }),
};

/** Padded base64 that decodes and re-encodes to the same text, so the host signs exactly the bytes the plugin meant. */
function isCanonicalBase64(s: string): boolean {
  return s.length % 4 === 0 && Buffer.from(s, "base64").toString("base64") === s;
}

export const METHOD_CAPABILITY: Readonly<Record<string, Capability>> = { ...HOSTS_METHOD_CAPABILITY, ...POLICY_METHOD_CAPABILITY, ...PLANNER_METHOD_CAPABILITY, ...SCOPED_METHOD_CAPABILITY, ...FS_WRITE_METHOD_CAPABILITY, ...HTTP_METHOD_CAPABILITY };

export function capabilityOf(method: string): Capability | null {
  if (Object.hasOwn(METHOD_CAPABILITY, method)) return METHOD_CAPABILITY[method]!;
  if (!method.startsWith("capability.")) return null;
  const name = method.slice("capability.".length);
  return (CAPABILITIES as readonly string[]).includes(name) ? (name as Capability) : null;
}

export const PLUGIN_STATES = ["disabled", "refused", "needs_grant", "idle", "starting", "ready", "failing"] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];
