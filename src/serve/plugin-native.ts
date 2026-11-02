import { z } from "zod";
import { parseOpParams } from "../api/ops";
import { toApiError } from "../api/errors";
import { CoreError } from "../core/errors";
import { pluginRegistry } from "../plugins";
import type { Ctx } from "../types";

const operation = z.enum([
  "plugin.list", "plugin.doctor", "plugin.ui.list", "plugin.settings.get",
]);
const request = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepare"), op: operation, params: z.unknown() }).strict(),
  z.object({ kind: z.literal("call"), id: z.string(), method: z.literal("diagnostic.ping"), params: z.unknown() }).strict(),
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
      // Doctor ignores successful ping payloads. Do not send arbitrary plugin
      // output through the native read bridge or execute a diagnostic twice.
      case "call": await reg.call(ctx, p.id, p.method, p.params); break;
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
