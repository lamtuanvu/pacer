import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { type Envelope, PLUGIN_KEY } from "./envelope";
import { channelPath } from "./paths";
export const CHANNEL_TTL_S=3600;
export function hasPluginSend(agentContext:unknown):boolean {
  const cmds=(agentContext as {commands?:{path?:unknown}[]}|null)?.commands;
  return Array.isArray(cmds)&&cmds.some(c=>Array.isArray(c.path)&&c.path.join(" ")==="plugin send");
}
export async function detectChannel(ctx:Ctx):Promise<boolean> {
  const cached=readJson<{checkedAt:number;available:boolean}>(channelPath(ctx)); if(cached&&ctx.now-cached.checkedAt<CHANNEL_TTL_S)return cached.available;
  let available=false; if(ctx.which("orca")) { const r=await ctx.run(["orca","agent-context","--json"],5000); if(r.code===0){try{available=hasPluginSend(JSON.parse(r.stdout));}catch{available=false;}} }
  writeJsonAtomic(channelPath(ctx),{checkedAt:ctx.now,available}); return available;
}
/** Proposed upstream shape (docs/upstream/orca-plugin-channel.md). */
export function channelArgv(e:Envelope):string[] { return ["orca","plugin","send",PLUGIN_KEY,"--data",JSON.stringify(e),"--json"]; }
export async function sendChannel(ctx:Ctx,e:Envelope):Promise<void> {
  const r=await ctx.run(channelArgv(e),10_000); if(r.code!==0){writeJsonAtomic(channelPath(ctx),{checkedAt:ctx.now,available:false});throw new Error(`orca plugin send exited ${r.code}: ${(r.stderr||r.stdout).split("\n")[0]}`);}
}
