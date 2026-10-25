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
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { pluginsConfig } from "./config";
import { CAPABILITY_METHODS, type PluginManifest, capabilityOf } from "./protocol";

export const pluginLogPath = (ctx: Pick<Ctx, "pacerHome">, id: string) => join(ctx.pacerHome, "logs", "plugins", `${id}.log`);

export function appendPluginLog(ctx: Pick<Ctx, "pacerHome">, id: string, tag: string, line: string): void {
  mkdirSync(join(ctx.pacerHome, "logs", "plugins"), { recursive: true, mode: 0o700 });
  appendFileSync(pluginLogPath(ctx, id), `${new Date().toISOString()} [${tag}] ${line}\n`, { mode: 0o600 });
}

/** Answer a plugin's capability call. Undeclared or unimplemented capabilities are refused without side effects. */
export async function answerCapability(ctx: Ctx, plugin: { id: string; manifest: PluginManifest; config?: Record<string, unknown> }, method: string, params: unknown, authority?: CallAuthority, deliver?: (result: unknown) => void, transport?: CapabilityTransport): Promise<unknown> {
  const name = capabilityOf(method), def = CAPABILITY_METHODS[method];
  if (!name) throw new CoreError("unknown_op", `unknown host method ${method}`);
  if (!plugin.manifest.capabilities.some(c => c.name === name)) throw new CoreError("capability_denied", `plugin ${plugin.id} did not declare ${name}`);
  if (!def) throw new CoreError("capability_denied", `${name} is not available in this pacer yet`);
  if (["fs.read", "fs.write", "process.spawn", "usage.state", "net.http", "secrets.resolve"].includes(name)) {
    if (!(authority instanceof CallAuthority)) throw new CoreError("capability_denied", "scoped capability requires an active owning call");
    authority.assertGranted(name);
  }
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map(i => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
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
  if (authority && name === "fs.read") return scoped(() => answerFilesystem(authority, scopes, method, parsed.data as Record<string, unknown>));
  if (authority && name === "process.spawn") return scoped(() => method === "capability.process.outputChunk"
    ? readSpawnOutput(authority, parsed.data as Record<string, unknown>) : answerSpawn(authority, scopes, parsed.data as Record<string, unknown>));
  if (authority && name === "usage.state") return scoped(() => answerUsageState(authority,
    method.slice("capability.usage.state.".length) as Parameters<typeof answerUsageState>[1], parsed.data as Record<string, unknown>));
  if (authority && name === "secrets.resolve") return scoped(() => secretPresence(authority, (parsed.data as { ref: string }).ref));
  if (authority && name === "net.http") {
    if (!transport) throw new CoreError("capability_denied", "HTTP requires a captured transport envelope");
    return scoped(() => answerHttp(authority, method, params ?? {}, transport));
  }
  switch (name) {
    case "log": { const p = parsed.data as { level: string; message: string }; appendPluginLog(ctx, plugin.id, p.level, p.message); return { ok: true }; }
    case "config.get": return { config: plugin.config ?? pluginsConfig(ctx).config[plugin.id] ?? {} };
    default: throw new CoreError("capability_denied", `${name} is not available in this pacer yet`);
  }
}
