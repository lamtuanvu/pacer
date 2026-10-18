import { compareVersions, currentVersion, isVersion } from "../update/version";
import { parseOrcaOutput } from "../exec/orca/client";
import { isObj } from "../util";
import { serviceInstalled } from "../service";
import { appendFileSync, readdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { type ConsoleData, type Envelope, type OutboxEvent, LIMITS, type LinkSnapshot, emptySnapshot, parseOutboxEvent, parseSnapshot } from "./envelope";
import { consolePath, consolesDir, latestPath, linkDir, outboxPath } from "./paths";
import { list as listStrategies } from "../strategy/service";
export const OUTBOX_MAX_BYTES = 1024 * 1024;
export const OUTBOX_KEEP = 1000;
export interface OutboxEntry { seq:number; at?:number; envelope:OutboxEvent }
export function readLatest(ctx:Ctx):LinkSnapshot { return parseSnapshot(readJson<unknown>(latestPath(ctx)))??emptySnapshot(); }
export function pidAlive(pid:number):boolean { try { process.kill(pid,0); return true; } catch(e) { return (e as NodeJS.ErrnoException).code==="EPERM"; } }
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
      const r = await ctx.run(["orca", "terminal", "list", "--json"], 1500);
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
  return {...readLatest(ctx),serviceInstalled:serviceInstalled(ctx),consoles,console:consoles[0] ?? (() => { const c = readConsole(ctx,alive); return c && consoleVersionCurrent(c) ? c : null; })(),strategies:listStrategies(ctx)};
}
export function appendOutbox(ctx:Ctx,entries:(OutboxEntry | {seq:number;at?:number;envelope:Envelope})[]):void {
  if(!entries.length)return; mkdirSync(linkDir(ctx),{recursive:true}); const p=outboxPath(ctx); appendFileSync(p,entries.map(e=>`${JSON.stringify({...e,envelope:{type:e.envelope.type,data:e.envelope.data}})}\n`).join(""));
  if(statSync(p).size>OUTBOX_MAX_BYTES || readFileSync(p,"utf8").split("\n").filter(Boolean).length>OUTBOX_KEEP) { const lines=readFileSync(p,"utf8").split("\n").filter(Boolean).slice(-OUTBOX_KEEP); writeFileSync(`${p}.tmp`,`${lines.join("\n")}\n`); renameSync(`${p}.tmp`,p); }
}
export function readOutboxSince(ctx:Ctx,seq:number):OutboxEntry[] {
  const p=outboxPath(ctx); if(!existsSync(p))return []; const out:OutboxEntry[]=[];
  for(const line of readFileSync(p,"utf8").split("\n")) { if(!line)continue; try { const raw=JSON.parse(line) as {seq?:unknown;at?:unknown;envelope?:unknown}; const envelope=parseOutboxEvent(raw.envelope); if(typeof raw.seq==="number"&&raw.seq>seq&&envelope)out.push({seq:raw.seq,...(typeof raw.at==="number"?{at:raw.at}:{}),envelope}); } catch { /* skip torn line */ } }
  return out;
}
