import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { type ConsoleData, type Envelope, LIMITS, type LinkSnapshot, emptySnapshot, parseEnvelope, parseSnapshot } from "./envelope";
import { consolePath, latestPath, linkDir, outboxPath } from "./paths";
export const OUTBOX_MAX_BYTES = 256 * 1024;
export const OUTBOX_KEEP = 200;
export interface OutboxEntry { seq:number; envelope:Envelope }
export function readLatest(ctx:Ctx):LinkSnapshot { return parseSnapshot(readJson<unknown>(latestPath(ctx)))??emptySnapshot(); }
export function pidAlive(pid:number):boolean { try { process.kill(pid,0); return true; } catch(e) { return (e as NodeJS.ErrnoException).code==="EPERM"; } }
export function readConsole(ctx:Ctx, alive:(pid:number)=>boolean=pidAlive):ConsoleData|null {
  const c=parseSnapshot({v:1,seq:0,at:0,console:readJson<unknown>(consolePath(ctx))})?.console??null;
  if(!c || ctx.now-c.heartbeatAt>LIMITS.heartbeatS || !alive(c.pid)) return null; return c;
}
export function writeConsole(ctx:Ctx,c:ConsoleData|null):void { if(c) writeJsonAtomic(consolePath(ctx),c); else rmSync(consolePath(ctx),{force:true}); }
export function currentSnapshot(ctx:Ctx,alive?:(pid:number)=>boolean):LinkSnapshot { return {...readLatest(ctx),console:readConsole(ctx,alive)}; }
export function appendOutbox(ctx:Ctx,entries:OutboxEntry[]):void {
  if(!entries.length)return; mkdirSync(linkDir(ctx),{recursive:true}); const p=outboxPath(ctx); appendFileSync(p,entries.map(e=>`${JSON.stringify(e)}\n`).join(""));
  if(statSync(p).size>OUTBOX_MAX_BYTES) { const lines=readFileSync(p,"utf8").split("\n").filter(Boolean).slice(-OUTBOX_KEEP); writeFileSync(`${p}.tmp`,`${lines.join("\n")}\n`); renameSync(`${p}.tmp`,p); }
}
export function readOutboxSince(ctx:Ctx,seq:number):OutboxEntry[] {
  const p=outboxPath(ctx); if(!existsSync(p))return []; const out:OutboxEntry[]=[];
  for(const line of readFileSync(p,"utf8").split("\n")) { if(!line)continue; try { const raw=JSON.parse(line) as {seq?:unknown;envelope?:unknown}; const envelope=parseEnvelope(raw.envelope); if(typeof raw.seq==="number"&&raw.seq>seq&&envelope)out.push({seq:raw.seq,envelope}); } catch { /* skip torn line */ } }
  return out;
}
