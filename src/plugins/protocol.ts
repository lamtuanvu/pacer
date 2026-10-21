import { z } from "zod";
import { isVersion } from "../update/version";

/** Plugin protocol version; independent of the client protocol (P4 applies to both). */
export const PLUGIN_PROTOCOL_VERSION = "1.0.0";
export const PLUGIN_PROTOCOL_MAJOR = 1;

export const EXTENSION_POINTS = ["diagnostic"] as const;
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

/** Host → plugin. Keys are `<extensionPoint>.<method>`; every plugin serves `diagnostic`. */
export const EXTENSION_METHODS: Record<string, MethodDef> = {
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
