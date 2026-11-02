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
const request = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepare"), op: operation, params: z.unknown() }).strict(),
  z.object({ kind: z.literal("call"), id: z.string(), method: z.enum(["diagnostic.ping", "ui.render", "ui.action", "ui.settings.validate"]), params: z.unknown() }).strict(),
  z.object({ kind: z.literal("stop"), id: z.string() }).strict(),
  z.object({ kind: z.literal("changed"), id: z.string(), reset: z.boolean(), invalidate: z.boolean() }).strict(),
  z.object({ kind: z.literal("publish"), op: operation }).strict(),
  z.object({ kind: z.literal("log"), id: z.string(), message: z.string().max(1000) }).strict(),
]);

/** Called only after internal-generation authentication, never on the public API. */
export async function pluginNativeRequest(ctx: Ctx, raw: unknown) {
  try {
    const parsed = request.safeParse(raw);
    if (!parsed.success) throw new CoreError("invalid_input", "invalid private plugin request");
    const p = parsed.data, reg = pluginRegistry(ctx);
    let value: unknown = null;
    switch (p.kind) {
      case "prepare": value = parseOpParams(ctx, p.op, p.params); break;
      case "call":
        value = await reg.call(ctx, p.id, p.method, p.params);
        if (p.method === "ui.action" && (value as { result?: string })?.result === "refresh") {
          reg.nativeDropCache(ctx, p.id, (p.params as { id: string }).id);
        }
        break;
      case "stop": await reg.nativeStop(ctx, p.id); break;
      case "changed":
        if (p.reset) reg.nativeReset(ctx, p.id);
        if (p.invalidate) reg.invalidatePlugin(ctx, p.id);
        break;
      case "publish":
        if (["plugin.enable", "plugin.disable", "plugin.remove", "plugin.ui.visibility", "plugin.settings.set"].includes(p.op)) await publishConfigChange(ctx, "plugins");
        break;
      case "log": appendPluginLog(ctx, p.id, "stderr", p.message); break;
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
      if (size > 256 * 1024) { await reader.cancel(); return new Response("too large\n", { status: 413 }); }
      chunks.push(part.value);
    }
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return new Response("invalid JSON\n", { status: 400 }); }
  return Response.json(await pluginNativeRequest({ ...ctx, operation: { signal: req.signal } }, raw));
}
