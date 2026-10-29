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

async function refuseSign(ctx: Ctx, pluginId: string, params: unknown, reason: string): Promise<void> {
  const purpose = (params as { purpose?: unknown } | null)?.purpose;
  const { auditSignature } = await import("../identity/audit");
  auditSignature(ctx, { pluginId, purpose: typeof purpose === "string" ? purpose.slice(0, 64) : "", outcome: "refused", reason });
}

/** Answer a plugin's capability call. Undeclared or unimplemented capabilities are refused without side effects. */
export async function answerCapability(ctx: Ctx, plugin: { id: string; manifest: PluginManifest }, method: string, params: unknown): Promise<unknown> {
  const name = capabilityOf(method), def = CAPABILITY_METHODS[method];
  if (!name) throw new CoreError("unknown_op", `unknown host method ${method}`);
  if (!plugin.manifest.capabilities.some(c => c.name === name)) {
    if (name === "identity.sign") await refuseSign(ctx, plugin.id, params, "capability not declared");
    throw new CoreError("capability_denied", `plugin ${plugin.id} did not declare ${name}`);
  }
  if (!def) throw new CoreError("capability_denied", `${name} is not available in this pacer yet`);
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) {
    if (name === "identity.sign") await refuseSign(ctx, plugin.id, params, "invalid request");
    throw new CoreError("invalid_input", parsed.error.issues.map(i => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  }
  switch (name) {
    case "log": { const p = parsed.data as { level: string; message: string }; appendPluginLog(ctx, plugin.id, p.level, p.message); return { ok: true }; }
    case "secrets.resolve": {
      // Only the key of the endpoint account the user chose for the assistant, and only for the plugin that serves it.
      const { ref } = parsed.data as { ref: string };
      const { assistantSecret } = await import("../assistant/service");
      return { value: await assistantSecret(ctx, plugin.id, ref) };
    }
    case "config.get": return { config: effectiveConfig(ctx, plugin.id) as never };
    case "identity.sign": {
      const p = parsed.data as { purpose: string; payload: string };
      const payload = Buffer.from(p.payload, "base64");
      const { auditSignature } = await import("../identity/audit");
      const refuse = (reason: string, message: string) => {
        auditSignature(ctx, { pluginId: plugin.id, purpose: p.purpose, payload, outcome: "refused", reason });
        return new CoreError("capability_denied", message);
      };
      const declared = plugin.manifest.capabilities.find(c => c.name === "identity.sign")?.scopes ?? [];
      if (!declared.includes(p.purpose)) throw refuse("purpose not declared", `identity.sign purpose ${p.purpose} is not declared in the manifest`);
      const { ensureIdentity, cloneSuspected, signFor } = await import("../identity");
      await ensureIdentity(ctx);
      // Maintainer decision 2026-10-29 (SEC-15): a copied home may share its key with another machine, so it signs nothing until rotated.
      if (await cloneSuspected(ctx)) throw refuse("home looks copied", "This home looks copied from another machine, so pacer will not sign with its key. Run pacer machine rotate --yes to give it its own identity.");
      // signFor records the signature in the host-owned identity audit log.
      const r = await signFor(ctx, plugin.id, p.purpose, payload);
      return { signature: Buffer.from(r.signature).toString("base64"), machineId: r.machineId };
    }
    default: throw new CoreError("capability_denied", `${name} is not available in this pacer yet`);
  }
}
