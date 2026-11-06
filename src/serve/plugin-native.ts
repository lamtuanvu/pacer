import { z } from "zod";
import { parseOpParams } from "../api/ops";
import { toApiError } from "../api/errors";
import { CoreError } from "../core/errors";
import { publishConfigChange } from "../core/events";
import { pluginRegistry } from "../plugins";
import { appendPluginLog } from "../plugins/host";
import type { Ctx } from "../types";

const operation = z.enum([
  "plugin.list", "plugin.enable", "plugin.disable", "plugin.remove", "plugin.doctor",
  "plugin.ui.list", "plugin.ui.render", "plugin.ui.action", "plugin.ui.visibility",
  "plugin.settings.get", "plugin.settings.set",
]);

/**
 * Private `/_internal/plugins` kinds.
 *
 * Flag-on (`PACER_HOST_SOCKET` set): prepare, spawn_spec, call_authority, ready,
 * stop, changed, publish, log. ProcessOwner owns plugin RPC, so `call` is
 * refused (P4d-5). Flag-off: the same surface plus `call` for diagnostic/UI
 * plugin methods.
 */
const callResources = z.object({
  reads: z.array(z.object({ path: z.string(), kind: z.enum(["file", "codex-logs"]) }).strict()).default([]),
  commands: z.array(z.object({
    argv: z.array(z.string()).min(1),
    timeoutMs: z.number().positive(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    stdin: z.string().optional(),
    suppressOutput: z.boolean().optional(),
  }).passthrough()).default([]),
  stores: z.array(z.unknown()).default([]),
  http: z.object({
    hosts: z.array(z.string()),
    origins: z.array(z.string()).optional(),
  }).strict().optional(),
}).passthrough();

const request = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepare"), op: operation, params: z.unknown() }).strict(),
  z.object({ kind: z.literal("call"), id: z.string(), method: z.enum(["diagnostic.ping", "ui.render", "ui.action", "ui.settings.validate"]), params: z.unknown() }).strict(),
  z.object({ kind: z.literal("spawn_spec"), id: z.string() }).strict(),
  z.object({
    kind: z.literal("call_authority"),
    id: z.string(),
    method: z.string().min(1),
    resources: callResources.optional(),
    ttlMs: z.number().positive().max(600_000).optional(),
  }).strict(),
  z.object({ kind: z.literal("ready"), id: z.string(), protocol: z.string(), served: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("stop"), id: z.string() }).strict(),
  z.object({ kind: z.literal("changed"), id: z.string(), reset: z.boolean(), invalidate: z.boolean() }).strict(),
  z.object({ kind: z.literal("publish"), op: operation }).strict(),
  z.object({ kind: z.literal("log"), id: z.string(), message: z.string().max(1000) }).strict(),
  z.object({
    kind: z.literal("orca_bridge"),
    token: z.string().min(1).max(128),
    pluginId: z.string().min(1),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
]);

/** Called only after internal-generation authentication, never on the public API. */
export async function pluginNativeRequest(ctx: Ctx, raw: unknown) {
  try {
    const parsed = request.safeParse(raw);
    if (!parsed.success) throw new CoreError("invalid_input", "invalid private plugin request");
    const p = parsed.data, reg = pluginRegistry(ctx);
    const nativeOwnsChildren = Boolean(ctx.env.PACER_HOST_SOCKET);
    let value: unknown = null;
    switch (p.kind) {
      case "prepare": value = parseOpParams(ctx, p.op, p.params); break;
      case "spawn_spec":
        // Flag-on ProcessOwner builds the OS child; Core only seals argv/hello.
        value = reg.nativeSpawnSpec(ctx, p.id);
        break;
      case "call_authority":
        // P4d-7: Core seals call-scoped CallResources for ProcessOwner natives.
        value = reg.nativeIssueCallAuthority(ctx, p.id, {
          method: p.method,
          resources: p.resources as import("../plugins/authority").CallResources | undefined,
          ttlMs: p.ttlMs,
        });
        break;
      case "ready":
        reg.nativeMarkReady(ctx, p.id, p.protocol, p.served);
        break;
      case "call": {
        if (nativeOwnsChildren) {
          // P4d-5: private call is retired on the native-owner path; Rust must
          // not send this kind when PACER_HOST_SOCKET is set.
          throw new CoreError(
            "plugin_unavailable",
            "private call is retired when the native process owner is active",
          );
        }
        // Doctor ignores successful ping payloads. Do not send arbitrary plugin
        // output through the native read bridge or execute a diagnostic twice.
        if (p.method === "diagnostic.ping") {
          await reg.call(ctx, p.id, p.method, p.params);
          break;
        }
        const dropCache = p.method === "ui.action"
          ? reg.nativeCacheInvalidator(ctx, p.id, (p.params as { id: string }).id) : undefined;
        value = await reg.call(ctx, p.id, p.method, p.params);
        if (p.method === "ui.action" && (value as { result?: string })?.result === "refresh") {
          dropCache?.();
        }
        break;
      }
      case "stop":
        // When Rust owns the OS child, stop still clears registry bookkeeping.
        await reg.nativeStop(ctx, p.id);
        break;
      case "changed":
        if (p.reset) reg.nativeReset(ctx, p.id);
        if (p.invalidate) reg.invalidatePlugin(ctx, p.id);
        break;
      case "publish":
        if (["plugin.enable", "plugin.disable", "plugin.remove", "plugin.ui.visibility", "plugin.settings.set"].includes(p.op)) await publishConfigChange(ctx, "plugins");
        break;
      case "log": appendPluginLog(ctx, p.id, "stderr", p.message); break;
      case "orca_bridge":
        value = await reg.nativeAnswerOrcaBridge(p.token, p.pluginId, p.method, p.params);
        break;
    }
    return { value, entries: reg.nativeSnapshot(ctx) };
  } catch (error) {
    // Errors do not discard the latest process state (crashes/backoff/retirement).
    let entries: ReturnType<ReturnType<typeof pluginRegistry>["nativeSnapshot"]> = [];
    try { entries = pluginRegistry(ctx).nativeSnapshot(ctx); }
    catch { /* Preserve the operation error when the strategy itself cannot load. */ }
    return { error: toApiError(error), entries };
  }
}

export async function pluginNativeRoute(ctx: Ctx, req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      // Public requests stay capped at 256 KiB. UTF8 replacement expands at
      // most 3x, and the trusted prepare wrapper adds a small fixed overhead.
      if (size > 1024 * 1024) { await reader.cancel(); return new Response("too large\n", { status: 413 }); }
      chunks.push(part.value);
    }
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return new Response("invalid JSON\n", { status: 400 }); }
  return Response.json(await pluginNativeRequest({ ...ctx, operation: { signal: req.signal } }, raw));
}
