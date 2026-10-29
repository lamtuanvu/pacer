// src/plugins/host.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { effectiveConfig } from "./settings";
import { CAPABILITY_METHODS, type PluginManifest, capabilityOf } from "./protocol";

export const pluginLogPath = (ctx: Pick<Ctx, "pacerHome">, id: string) => join(ctx.pacerHome, "logs", "plugins", `${id}.log`);

export function appendPluginLog(ctx: Pick<Ctx, "pacerHome">, id: string, tag: string, line: string): void {
  mkdirSync(join(ctx.pacerHome, "logs", "plugins"), { recursive: true, mode: 0o700 });
  const path = pluginLogPath(ctx, id);
  try { if (statSync(path).size >= PLUGIN_LOG_MAX_BYTES) renameSync(path, `${path}.1`); } catch { /* no log yet */ }
  appendFileSync(path, `${new Date().toISOString()} [${tag}] ${line.slice(0, 4096)}\n`, { mode: 0o600 });
}
/** One generation of rotation keeps a plugin-controlled log under twice this size. */
export const PLUGIN_LOG_MAX_BYTES = 1024 * 1024;

/** Answer a plugin's capability call. Undeclared or unimplemented capabilities are refused without side effects. */
export async function answerCapability(ctx: Ctx, plugin: { id: string; manifest: PluginManifest }, method: string, params: unknown): Promise<unknown> {
  const name = capabilityOf(method), def = CAPABILITY_METHODS[method];
  if (!name) throw new CoreError("unknown_op", `unknown host method ${method}`);
  if (!plugin.manifest.capabilities.some(c => c.name === name)) throw new CoreError("capability_denied", `plugin ${plugin.id} did not declare ${name}`);
  if (!def) throw new CoreError("capability_denied", `${name} is not available in this pacer yet`);
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map(i => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  switch (name) {
    case "log": { const p = parsed.data as { level: string; message: string }; appendPluginLog(ctx, plugin.id, p.level, p.message); return { ok: true }; }
    case "secrets.resolve": {
      // Only the key of the endpoint account the user chose for the assistant, and only for the plugin that serves it.
      const { ref } = parsed.data as { ref: string };
      const { assistantSecret } = await import("../assistant/service");
      return { value: await assistantSecret(ctx, plugin.id, ref) };
    }
    case "config.get": return { config: effectiveConfig(ctx, plugin.id) as never };
    default: throw new CoreError("capability_denied", `${name} is not available in this pacer yet`);
  }
}
