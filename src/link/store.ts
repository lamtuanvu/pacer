import { compareVersions, currentVersion, isVersion } from "../update/version";
import { parseOrcaOutput } from "../exec/orca/client";
import { sanitizedOrcaEnv } from "../exec/attestation-env";
import { isObj } from "../util";
import { sliceText } from "../util";
import { serviceInstalled } from "../service";
import { chmodSync, closeSync, fchmodSync, openSync, readdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { type ConsoleData, type OutboxEvent, LIMITS, type LinkSnapshot, emptySnapshot, parseSnapshot } from "./envelope";
import { replayOutbox } from "./outbox-index";
import { consolePath, consolesDir, latestPath, linkDir, outboxPath } from "./paths";
import { list as listStrategies } from "../strategy/service";
import { pidAlive } from "./pid";
export const OUTBOX_MAX_BYTES = 1024 * 1024;
export const OUTBOX_KEEP = 1000;
/** Rotation waits until the outbox is a quarter past a limit, so most appends keep the file and its replay index. */
export const OUTBOX_ROTATE_LINES = Math.ceil(OUTBOX_KEEP * 1.25);
export const OUTBOX_ROTATE_BYTES = Math.ceil(OUTBOX_MAX_BYTES * 1.25);
export interface OutboxEntry { seq:number; at?:number; envelope:OutboxEvent }
const outboxListeners = new Map<string, Set<() => void>>();
/** Process-local wakeup only; readers still poll for writes from other processes. */
export function subscribeOutbox(ctx: Ctx, listener: () => void): () => void {
  let listeners = outboxListeners.get(ctx.pacerHome);
  if (!listeners) outboxListeners.set(ctx.pacerHome, listeners = new Set());
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) outboxListeners.delete(ctx.pacerHome);
  };
}
export function readLatest(ctx:Ctx):LinkSnapshot { return parseSnapshot(readJson<unknown>(latestPath(ctx)))??emptySnapshot(); }
export { pidAlive } from "./pid";
export function readConsole(ctx:Ctx, alive:(pid:number)=>boolean=pidAlive):ConsoleData|null {
  const c=parseSnapshot({v:1,seq:0,at:0,console:readJson<unknown>(consolePath(ctx))})?.console??null;
  if(!c || ctx.now-c.heartbeatAt>LIMITS.heartbeatS || !alive(c.pid)) return null; return c;
}
const safeHandle = (handle: string | null | undefined): handle is string => !!handle && /^[A-Za-z0-9_-]+$/.test(handle);
const terminalCache = new Map<string, { checked: number; listedAt?: number; unknownChecked?: number; handles?: Set<string>; pending?: Promise<void> }>();
const registrations = new Map<string,{at:number;values:{path:string;raw:unknown}[]}>();
export function invalidateConsoleCache(ctx:Ctx):void {registrations.delete(ctx.pacerHome);}
function cachedRegistrations(ctx:Ctx):{path:string;raw:unknown}[] {
  const hit=registrations.get(ctx.pacerHome);
  if(hit && ctx.now-hit.at>=0 && ctx.now-hit.at<2)return hit.values;
  const values=registrationPaths(ctx).map(path=>({path,raw:readJson<unknown>(path)}));
  registrations.set(ctx.pacerHome,{at:ctx.now,values});return values;
}
function registrationPaths(ctx: Ctx): string[] {
  const dir = consolesDir(ctx);
  return [consolePath(ctx), ...(existsSync(dir) ? readdirSync(dir).filter(f => /^[A-Za-z0-9_-]+\.json$/.test(f)).map(f => join(dir, f)) : [])];
}
/** Failed or partial Orca queries never authorize deleting registrations. */
export async function refreshConsoleTerminals(ctx: Ctx, unknown = false): Promise<void> {
  const prior = terminalCache.get(ctx.pacerHome);
  if (prior?.pending) return prior.pending;
  unknown ||= !!prior?.handles && registrationPaths(ctx).some(path => {
    const c = readJson<ConsoleData>(path); return !!c?.handle && !prior.handles!.has(c.handle);
  });
  if (prior && (unknown ? ctx.now - (prior.unknownChecked ?? -Infinity) < 5 : ctx.now - prior.checked < 10)) return;
  const entry = { checked: ctx.now, unknownChecked: unknown ? ctx.now : prior?.unknownChecked } as NonNullable<ReturnType<typeof terminalCache.get>>;
  // Invalidate the old membership before querying: an error cannot leave deletion authority behind.
  terminalCache.set(ctx.pacerHome, entry);
  const listedAt = ctx.now;
  entry.pending = (async () => {
    if (!ctx.which("orca")) return;
    try {
      const r = await ctx.run(["orca", "terminal", "list", "--json"], 1500, { env: sanitizedOrcaEnv(ctx.env) });
      const reply = parseOrcaOutput(r.stdout);
      if (r.code !== 0 || !isObj(reply) || reply.ok !== true || !isObj(reply.result) || !Array.isArray(reply.result.terminals)) return;
      if (!completeTerminalList(reply) || !completeTerminalList(reply.result)) return;
      if (!reply.result.terminals.every(t => isObj(t) && typeof t.handle === "string")) return;
      entry.listedAt = listedAt;
      invalidateConsoleCache(ctx);
      entry.handles = new Set(reply.result.terminals.map(t => t.handle as string));
      readConsoles(ctx, pidAlive, false);
      invalidateConsoleCache(ctx);
    } catch { /* Preserve registrations when the runtime is unavailable. */ }
  })();
  try { await entry.pending; } finally { entry.pending = undefined; }
}
export function completeTerminalList(value: Record<string, unknown>): boolean {
  return value.truncated !== true && value.hasMore !== true && !value.error &&
    (!isObj(value.page) || value.page.hasMore !== true && !value.page.nextCursor) &&
    (!isObj(value.pagination) || value.pagination.hasMore !== true && !value.pagination.nextCursor);
}
export function forgetConsoles(ctx: Ctx, worktreeId: string): void {
  invalidateConsoleCache(ctx);
  const dir = consolesDir(ctx);
  if (existsSync(dir)) for (const file of readdirSync(dir)) if (/^[A-Za-z0-9_-]+\.json$/.test(file)) {
    const path = join(dir, file); if (readJson<ConsoleData>(path)?.worktreeId === worktreeId) rmSync(path, { force: true });
  }
  if (readJson<ConsoleData>(consolePath(ctx))?.worktreeId === worktreeId) rmSync(consolePath(ctx), { force: true });
}
export function readConsoles(ctx:Ctx,alive:(pid:number)=>boolean=pidAlive, refreshUnknown = true):ConsoleData[] {
  const dir=consolesDir(ctx), found=new Map<string,ConsoleData>();
  const add=(raw:unknown,path?:string) => {
    const c=parseSnapshot({v:1,seq:0,at:0,console:raw})?.console;
    if(!c) return;
    const cached = terminalCache.get(ctx.pacerHome);
    const missing = !!c.handle && !!cached?.handles && !cached.handles.has(c.handle);
    if (missing && refreshUnknown) void refreshConsoleTerminals(ctx, true);
    if(ctx.now-c.heartbeatAt>600 || !alive(c.pid) || (missing && (!refreshUnknown || !terminalCache.get(ctx.pacerHome)?.pending) && c.startedAt < (cached?.listedAt ?? -Infinity))) { if(path) rmSync(path,{force:true}); return; }
    if(!c.handle) return;
    const previous=found.get(c.handle);
    if(!previous || previous.heartbeatAt<c.heartbeatAt) found.set(c.handle,c);
  };
  for(const entry of cachedRegistrations(ctx))add(entry.raw,entry.path);
  return [...found.values()].sort((a,b)=>b.heartbeatAt-a.heartbeatAt).slice(0,32);
}
export function writeConsole(ctx:Ctx,c:ConsoleData|null,handle?:string):void {
  invalidateConsoleCache(ctx);
  if(c) {
    if(safeHandle(c.handle)) writeJsonAtomic(join(consolesDir(ctx),`${c.handle}.json`),c);
    writeJsonAtomic(consolePath(ctx),c);
  } else {
    const legacy=readJson<ConsoleData>(consolePath(ctx));
    if(handle === undefined) {
      const dir=consolesDir(ctx);
      if(existsSync(dir)) for(const file of readdirSync(dir)) if(/^[A-Za-z0-9_-]+\.json$/.test(file)) {
        const path=join(dir,file);
        if(readJson<ConsoleData>(path)?.pid===process.pid) rmSync(path,{force:true});
      }
      if(legacy?.pid===process.pid) rmSync(consolePath(ctx),{force:true});
    } else {
      if(safeHandle(handle)) rmSync(join(consolesDir(ctx),`${handle}.json`),{force:true});
      if(legacy?.handle===handle) rmSync(consolePath(ctx),{force:true});
    }
  }
}
export function consoleVersionCurrent(c: ConsoleData): boolean {
  return c.version === undefined || isVersion(c.version) && compareVersions(c.version, currentVersion()) >= 0;
}
export function currentSnapshot(ctx:Ctx,alive?:(pid:number)=>boolean):LinkSnapshot {
  const consoles=readConsoles(ctx,alive).filter(consoleVersionCurrent);
  return {...readLatest(ctx),serviceInstalled:serviceInstalled(ctx),consoles,console:consoles[0] ?? (() => { const c = readConsole(ctx,alive); return c && consoleVersionCurrent(c) ? c : null; })(),strategies:listStrategies(ctx).map(strategy => ({...strategy, description:sliceText(strategy.description,1000)}))};
}
export function appendOutbox(ctx:Ctx,entries:OutboxEntry[], rotate = true, notify = true):void {
  if(!entries.length)return; mkdirSync(linkDir(ctx),{recursive:true,mode:0o700}); chmodSync(linkDir(ctx),0o700); const p=outboxPath(ctx);
  const fd=openSync(p,"a",0o600);
  try { fchmodSync(fd,0o600); writeFileSync(fd,entries.map(e=>`${JSON.stringify({...e,envelope:{type:e.envelope.type,data:e.envelope.data}})}\n`).join("")); }
  finally { closeSync(fd); }
  if (rotate) rotateOutbox(ctx);
  if (notify) notifyOutbox(ctx);
}
let crossOutboxPost: (() => void) | null = null;
/** Let a background Worker bridge outbox wake-ups to the request thread's own listeners. */
export function setOutboxCrossPost(fn: (() => void) | null): void {
  crossOutboxPost = fn;
}
export function notifyOutbox(ctx:Ctx):void {
  for (const listener of outboxListeners.get(ctx.pacerHome) ?? []) listener();
  // A periodic loop that publishes from another isolate wakes SSE on the request thread.
  crossOutboxPost?.();
}
/**
 * Rotate only after a publisher has committed latest.json, keeping an interrupted append replayable.
 * A rotation keeps the newest lines within both OUTBOX_KEEP and OUTBOX_MAX_BYTES, and always the newest line.
 */
export function rotateOutbox(ctx:Ctx):void {
  const p=outboxPath(ctx), size=statSync(p).size, all=readFileSync(p,"utf8").split("\n").filter(Boolean);
  if(size>OUTBOX_ROTATE_BYTES || all.length>OUTBOX_ROTATE_LINES) {
    let start=all.length, bytes=0;
    while(start>0 && all.length-start<OUTBOX_KEEP) {
      bytes+=Buffer.byteLength(all[start-1]!)+1;
      if(bytes>OUTBOX_MAX_BYTES && start<all.length) break;
      start--;
    }
    const lines=all.slice(start), tmp=`${p}.${process.pid}.${randomUUID()}.tmp`;
    const rotation=openSync(tmp,"wx",0o600);
    try { writeFileSync(rotation,`${lines.join("\n")}\n`); closeSync(rotation); renameSync(tmp,p); }
    catch(error) { try { closeSync(rotation); } catch { /* already closed */ } unlinkSync(tmp); throw error; }
  }
}
export function readOutboxSince(ctx:Ctx,seq:number):OutboxEntry[] {
  return replayOutbox(ctx,seq).entries;
}
