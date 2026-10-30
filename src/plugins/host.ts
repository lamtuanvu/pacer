import { plannerBorrow } from "./planner-resources";
import { answerWrite, checkWriteAuthority } from "./capability-write";
import { fileWriteTransfers } from "./file-write-transfers";
import { FILE_WRITE_CHUNK_FEATURE } from "./write-protocol";
import { answerHttp } from "./capability-http";
import { secretPresence } from "./http-authority";
import type { CapabilityTransport } from "./process";
// src/plugins/host.ts
import { CallAuthority } from "./authority";
import { answerUsageState } from "./usage-state";
import { answerFilesystem } from "./capability-fs";
import { answerSpawn, readSpawnOutput } from "./capability-spawn";
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
export async function answerCapability(ctx: Ctx, plugin: { id: string; manifest: PluginManifest; config?: Record<string, unknown> }, method: string, params: unknown, authority?: CallAuthority, deliver?: (result: unknown) => void, transport?: CapabilityTransport): Promise<unknown> {
  const name = capabilityOf(method), def = CAPABILITY_METHODS[method];
  if(name==="tasks.read"||name==="events.subscribe")throw new CoreError("capability_denied","observations require the generation-aware registry broker");
  if (!name) throw new CoreError("unknown_op", `unknown host method ${method}`);
  if (!plugin.manifest.capabilities.some(c => c.name === name)) {
    if (name === "identity.sign") await refuseSign(ctx, plugin.id, params, "capability not declared");
    throw new CoreError("capability_denied", `plugin ${plugin.id} did not declare ${name}`);
  }
  if (!def) throw new CoreError("capability_denied", `${name} is not available in this pacer yet`);
  // capability.secrets.resolve keeps its 1.3.0 assistant contract and needs no owning call; capability.secrets.check does.
  if (["fs.read", "fs.write", "process.spawn", "usage.state", "net.http", "secrets.resolve"].includes(name) && method !== "capability.secrets.resolve") {
    if (!(authority instanceof CallAuthority)) throw new CoreError("capability_denied", "scoped capability requires an active owning call");
    authority.assertGranted(name);
  }
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) {
    if (name === "identity.sign") await refuseSign(ctx, plugin.id, params, "invalid request");
    throw new CoreError("invalid_input", parsed.error.issues.map(i => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  }
  const scoped = (action: () => Promise<unknown>) => authority!.exclusive(async () => {
    const deadline = def.deadlineMs === 0 ? authority!.deadlineMs : Math.min(authority!.deadlineMs, Date.now() + def.deadlineMs);
    const failure = new CoreError("plugin_timeout", `${method} passed its capability deadline`);
    const expire = () => { void authority!.revoke(failure).catch(() => {}); };
    const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    try {
      const result = await action();
      if (Date.now() >= deadline) { expire(); throw failure; }
      if (deliver) deliver(result);
      return result;
    } catch (error) {
      if (authority!.signal.reason === failure) throw failure;
      throw error;
    } finally { clearTimeout(timer); }
  });
  const scopes = plugin.manifest.capabilities.find(capability => capability.name === name)?.scopes ?? [];
  if (authority && name === "fs.write") {
    if (!transport) throw new CoreError("capability_denied", "file writes require a captured transport envelope");
    if (!transport.requestFits(parsed.data)) throw new CoreError("too_large", "file write request exceeds transport limit");
    if (!["capability.fs.beginWrite", "capability.fs.writeChunk"].includes(method) && !transport.resultFits({ok:true})) throw new CoreError("too_large", "file write acknowledgement exceeds transport limit");
    const params = parsed.data as Record<string, any>;
    if (["capability.fs.write", "capability.fs.mkdir", "capability.fs.remove"].includes(method)) {
      return scoped(() => answerWrite(authority, scopes, method, method === "capability.fs.write" ? {path:params.path,text:params.text} : params));
    }
    if (!transport?.features.includes(FILE_WRITE_CHUNK_FEATURE)) throw new CoreError("capability_denied", "file writes require negotiated chunk transport");
    const capturedScopes = Object.freeze([...scopes]);
    const transfers = fileWriteTransfers(authority, {
      authorize: path => checkWriteAuthority(authority, capturedScopes, path, "write"),
      write: (path, text) => answerWrite(authority, capturedScopes, "capability.fs.write", {path, text}),
    });
    return scoped(async () => {
      switch (method) {
        case "capability.fs.beginWrite": return transfers.begin(params.path, params.bytes, params.mode, value => transport.resultFits(value));
        case "capability.fs.writeChunk": return transfers.append(params.handle, params.offset, params.base64, value => transport.resultFits(value));
        case "capability.fs.commitWrite": return transfers.commit(params.handle);
        case "capability.fs.releaseWrite": return transfers.release(params.handle);
        default: throw new CoreError("unknown_op", "unknown file write method");
      }
    });
  }
  if (authority && method === "capability.planner.readPriorRange") return scoped(() => {
    const lease=plannerBorrow(authority);
    if(!transport?.features.includes("plannerInstallTransactions")||!lease)throw new CoreError("capability_denied","prior record requires trusted install admission");
    if(!transport.requestFits(parsed.data))throw new CoreError("too_large","prior range exceeds frame limit");
    return lease.readPrior(authority,parsed.data as Record<string,unknown>);
  });
  if (authority && method === "capability.planner.run") return scoped(() => {
    const lease = plannerBorrow(authority);
    if (!transport?.features.includes("plannerInstallTransactions") || !lease) throw new CoreError("capability_denied", "planner command requires trusted install admission");
    if (!transport.requestFits(parsed.data)) throw new CoreError("too_large", "planner command exceeds transport frame");
    return lease.run(authority, scopes, parsed.data);
  });
  if (authority && method === "capability.process.outputChunk" && plannerBorrow(authority)) return scoped(() => plannerBorrow(authority)!.readOutput(authority, parsed.data as Record<string,unknown>));
  if (authority && name === "fs.read" && plannerBorrow(authority)) return scoped(() => plannerBorrow(authority)!.read(authority,scopes,method,parsed.data as Record<string,unknown>));
  if (authority && name === "fs.read") return scoped(() => answerFilesystem(authority, scopes, method, parsed.data as Record<string, unknown>));
  if (authority && name === "process.spawn") return scoped(() => method === "capability.process.outputChunk"
    ? readSpawnOutput(authority, parsed.data as Record<string, unknown>) : answerSpawn(authority, scopes, parsed.data as Record<string, unknown>));
  if (authority && name === "usage.state") return scoped(() => answerUsageState(authority,
    method.slice("capability.usage.state.".length) as Parameters<typeof answerUsageState>[1], parsed.data as Record<string, unknown>));
  if (authority && method === "capability.secrets.check") return scoped(() => secretPresence(authority, (parsed.data as { ref: string }).ref));
  if (authority && name === "net.http") {
    if (!transport) throw new CoreError("capability_denied", "HTTP requires a captured transport envelope");
    return scoped(() => answerHttp(authority, method, params ?? {}, transport));
  }
  switch (name) {
    case "log": { const p = parsed.data as { level: string; message: string }; appendPluginLog(ctx, plugin.id, p.level, p.message); return { ok: true }; }
    case "secrets.resolve": {
      // Only the key of the endpoint account the user chose for the assistant, and only for the plugin that serves it.
      const { ref } = parsed.data as { ref: string };
      const { assistantSecret } = await import("../assistant/service");
      return { value: await assistantSecret(ctx, plugin.id, ref) };
    }
    case "config.get": return { config: (plugin.config ?? effectiveConfig(ctx, plugin.id)) as never };
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
