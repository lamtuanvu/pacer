import { compareVersions, currentVersion, isVersion } from "../update/version";
import { parseOrcaOutput } from "../exec/orca/client";
import { isObj } from "../util";
import { serviceInstalled } from "../service";
import { appendFileSync, readdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { type ConsoleData, type Envelope, LIMITS, type LinkSnapshot, emptySnapshot, parseEnvelope, parseSnapshot } from "./envelope";
import { consolePath, consolesDir, latestPath, linkDir, outboxPath } from "./paths";
import { list as listStrategies } from "../strategy/service";
export const OUTBOX_MAX_BYTES = 256 * 1024;
export const OUTBOX_KEEP = 200;
export interface OutboxEntry { seq:number; envelope:Envelope }
export function readLatest(ctx:Ctx):LinkSnapshot { return parseSnapshot(readJson<unknown>(latestPath(ctx)))??emptySnapshot(); }
export function pidAlive(pid:number):boolean { try { process.kill(pid,0); return true; } catch(e) { return (e as NodeJS.ErrnoException).code==="EPERM"; } }
export function readConsole(ctx:Ctx, alive:(pid:number)=>boolean=pidAlive):ConsoleData|null {
  const c=parseSnapshot({v:1,seq:0,at:0,console:readJson<unknown>(consolePath(ctx))})?.console??null;
  if(!c || ctx.now-c.heartbeatAt>LIMITS.heartbeatS || !alive(c.pid)) return null; return c;
}
const safeHandle = (handle: string | null | undefined): handle is string => !!handle && /^[A-Za-z0-9_-]+$/.test(handle);
const terminalCache = new Map<string, { checked: number; handles?: Set<string> }>();
/** Failed/unavailable Orca queries never authorize deleting registrations. */
export async function refreshConsoleTerminals(ctx: Ctx): Promise<void> {
  const prior = terminalCache.get(ctx.pacerHome);
  if (prior && Date.now() - prior.checked < 30000) return;
  terminalCache.set(ctx.pacerHome, { ...prior, checked: Date.now() });
  if (!ctx.which("orca")) return;
  try {
    const r = await ctx.run(["orca", "terminal", "list", "--json"], 1500);
    const reply = parseOrcaOutput(r.stdout);
    if (r.code !== 0 || !isObj(reply) || reply.ok !== true || !isObj(reply.result) || !Array.isArray(reply.result.terminals)) return;
    if (!reply.result.terminals.every(t => isObj(t) && typeof t.handle === "string")) return;
    terminalCache.set(ctx.pacerHome, { checked: Date.now(), handles: new Set(reply.result.terminals.map(t => t.handle as string)) });
    readConsoles(ctx);
  } catch { /* Preserve registrations when the runtime is unavailable. */ }
}
export function forgetConsoles(ctx: Ctx, worktreeId: string): void {
  const dir = consolesDir(ctx);
  if (existsSync(dir)) for (const file of readdirSync(dir)) if (/^[A-Za-z0-9_-]+\.json$/.test(file)) {
    const path = join(dir, file); if (readJson<ConsoleData>(path)?.worktreeId === worktreeId) rmSync(path, { force: true });
  }
  if (readJson<ConsoleData>(consolePath(ctx))?.worktreeId === worktreeId) rmSync(consolePath(ctx), { force: true });
}
export function readConsoles(ctx:Ctx,alive:(pid:number)=>boolean=pidAlive):ConsoleData[] {
  const dir=consolesDir(ctx), found=new Map<string,ConsoleData>();
  const add=(raw:unknown,path?:string) => {
    const c=parseSnapshot({v:1,seq:0,at:0,console:raw})?.console;
    if(!c) return;
    if(ctx.now-c.heartbeatAt>600 || !alive(c.pid) || (c.handle && terminalCache.get(ctx.pacerHome)?.handles && !terminalCache.get(ctx.pacerHome)!.handles!.has(c.handle))) { if(path) rmSync(path,{force:true}); return; }
    if(!c.handle) return;
    const previous=found.get(c.handle);
    if(!previous || previous.heartbeatAt<c.heartbeatAt) found.set(c.handle,c);
  };
  if(existsSync(dir)) for(const file of readdirSync(dir)) if(/^[A-Za-z0-9_-]+\.json$/.test(file)) {
    const path=join(dir,file);add(readJson<unknown>(path),path);
  }
  add(readJson<unknown>(consolePath(ctx)),consolePath(ctx));
  return [...found.values()].sort((a,b)=>b.heartbeatAt-a.heartbeatAt).slice(0,32);
}
export function writeConsole(ctx:Ctx,c:ConsoleData|null,handle?:string):void {
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
export function appendOutbox(ctx:Ctx,entries:OutboxEntry[]):void {
  if(!entries.length)return; mkdirSync(linkDir(ctx),{recursive:true}); const p=outboxPath(ctx); appendFileSync(p,entries.map(e=>`${JSON.stringify(e)}\n`).join(""));
  if(statSync(p).size>OUTBOX_MAX_BYTES) { const lines=readFileSync(p,"utf8").split("\n").filter(Boolean).slice(-OUTBOX_KEEP); writeFileSync(`${p}.tmp`,`${lines.join("\n")}\n`); renameSync(`${p}.tmp`,p); }
}
export function readOutboxSince(ctx:Ctx,seq:number):OutboxEntry[] {
  const p=outboxPath(ctx); if(!existsSync(p))return []; const out:OutboxEntry[]=[];
  for(const line of readFileSync(p,"utf8").split("\n")) { if(!line)continue; try { const raw=JSON.parse(line) as {seq?:unknown;envelope?:unknown}; const envelope=parseEnvelope(raw.envelope); if(typeof raw.seq==="number"&&raw.seq>seq&&envelope)out.push({seq:raw.seq,envelope}); } catch { /* skip torn line */ } }
  return out;
}
