import { checkDraftPath } from "./paths";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadStrategy, useStrategy, validateStrategy, StrategyError, type Strategy } from "../config/strategy";
import { computeStatus, displayName } from "../engine/status";
import { listStrategies } from "../link/strategies";
import { publish } from "../link/publish";
import type { Ctx, UsageReading } from "../types";
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export interface Draft { from: string; set?: Record<string, JSONValue>; unset?: string[]; description?: string }
export function checkName(name: string, writable=false): void {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || writable && name === "default") throw new Error(`invalid strategy name "${name}"${writable ? "; default is protected" : ""}`);
}
export function pathFor(ctx: Ctx, name: string): string { if(!listStrategies(ctx).includes(name)) throw new Error(`unknown strategy "${name}"`); return name === "default" ? join(ctx.pacerHome,"strategy.yaml") : join(ctx.pacerHome,"strategies",`${name}.yaml`); }
export function summarize(s: Strategy): string {
  const first=s.pacing.order.find(id=>id!==s.planner);
  return `${first ? displayName(first)+" first" : "Configured executors"}, ${displayName(s.planner)} keeps ${s.pacing.plannerReserve}%${s.pacing.policy === "priority" ? "" : `; ${s.pacing.policy} policy`}`;
}
export function show(ctx: Ctx, name: string) {
  const path=pathFor(ctx,name), yaml=readFileSync(path,"utf8"), s=validateStrategy(Bun.YAML.parse(yaml),path,name);
  return {yaml,summary:summarize(s),active:loadStrategy(ctx).name===name};
}
export function list(ctx: Ctx) {
  return listStrategies(ctx).map(name=>{try { const r=show(ctx,name); return {name,active:r.active,summary:r.summary,description:description(r.yaml)}; } catch {return {name,active:false,summary:"Invalid or missing strategy",description:""};}});
}
function description(yaml:string):string {
  const first=/^#\s?(.*)/.exec(yaml)?.[1]??"";
  return /^pacer starter strategy/i.test(first) ? "" : first;
}
export function applyDraft(raw: unknown, draft: Draft): unknown {
  const root=structuredClone(raw);
  if (!root || typeof root!=="object" || Array.isArray(root)) throw new Error("base strategy must be a mapping");
  const change=(path:string,value:JSONValue|undefined,remove:boolean)=>{
    const keys=path.split(".");
    if(keys.some(k=>!k || ["__proto__","prototype","constructor"].includes(k))) throw new Error(`invalid dotted path "${path}"`);
    checkDraftPath(keys,path);
    let node=root as Record<string,unknown>;
    for(const key of keys.slice(0,-1)) {
      if(node[key]===undefined) {if(remove)return; node[key]={};}
      if(!node[key] || typeof node[key]!=="object" || Array.isArray(node[key])) throw new Error(`cannot traverse "${path}"; arrays and scalars replace wholesale`);
      node=node[key] as Record<string,unknown>;
    }
    const key=keys.at(-1)!; if(remove) delete node[key]; else node[key]=structuredClone(value);
  };
  for(const [key,value] of Object.entries(draft.set??{})) change(key,value,false);
  for(const key of draft.unset??[]) change(key,undefined,true);
  return root;
}
function draftYaml(ctx:Ctx,draft:Draft) {
  const raw=applyDraft(Bun.YAML.parse(readFileSync(pathFor(ctx,draft.from),"utf8")),draft);
  return {raw,yaml:Bun.YAML.stringify(raw,null,2).replace(/\n?$/, "\n")};
}
function materialize(ctx:Ctx,draft:Draft) {
  const {raw,yaml}=draftYaml(ctx,draft);
  return {strategy:validateStrategy(raw,"draft",draft.from),yaml};
}
export async function preview(ctx:Ctx,draft:Draft) {
  ctx={...ctx,readOnly:true};
  const readings=new Map<string,UsageReading>();
  const current=loadStrategy(ctx), status=await computeStatus(ctx,current,{readings});
  const ranking={current:status.executors.ranked.map(x=>x.id),draft:[] as string[]};
  let yaml="";
  try { const serialized=draftYaml(ctx,draft);yaml=serialized.yaml; const d={yaml,strategy:validateStrategy(serialized.raw,"draft",draft.from)}, st=await computeStatus(ctx,d.strategy,{readings}); ranking.draft=st.executors.ranked.map(x=>x.id);
    return {ok:true,errors:[] as string[],yaml:d.yaml,summary:summarize(d.strategy),ranking,routing:{current:current.routing,draft:d.strategy.routing}};
  } catch(e) {return {ok:false,errors:e instanceof StrategyError ? e.problems : [String((e as Error).message)],yaml,summary:"",ranking,routing:{current:current.routing,draft:[]}};}
}
const line=(text:string)=>text.replace(/[\r\n\x00-\x1f]/g," ");
export function save(ctx:Ctx,name:string,draft:Draft,reason:string,opts:{overwrite?:boolean;activeOk?:boolean;who?:string}={}) {
  checkName(name,true); if(!reason.trim()) throw new Error("a save reason is required");
  const {yaml,strategy}=materialize(ctx,draft), path=join(ctx.pacerHome,"strategies",`${name}.yaml`);
  if(existsSync(path)&&!opts.overwrite) throw new Error(`strategy "${name}" already exists; use overwrite:true to replace it`);
  if(existsSync(path)&&loadStrategy(ctx).name===name&&!opts.activeOk) throw new Error(`strategy "${name}" is active; overwriting changes live routing; use activeOk:true to approve`);
  mkdirSync(join(ctx.pacerHome,"strategies"),{recursive:true});
  const who=line(opts.who??ctx.env.PACER_AGENT??ctx.env.ORCA_AGENT??"agent");
  const content=`# ${line(draft.description??summarize(strategy))}\n# created by ${who} on ${new Date(ctx.now*1000).toISOString()}: ${line(reason)}\n${yaml}`;
  const tmp=`${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {writeFileSync(tmp,content,{flag:"wx"}); if(existsSync(path)&&!opts.overwrite) throw new Error(`strategy "${name}" already exists`); if(opts.overwrite) renameSync(tmp,path); else linkSync(tmp,path);} finally {rmSync(tmp,{force:true});}
  return {name,path,summary:summarize(strategy),active:loadStrategy(ctx).name===name};
}
export async function use(ctx:Ctx,name:string):Promise<string> {
  show(ctx,name); const path=useStrategy(ctx,name);
  await publish(ctx,[{v:1,type:"alert",data:{key:"strategy-switch",level:"info",title:`Strategy switched to ${name}`,body:summarize(loadStrategy(ctx)),at:ctx.now}}]); return path;
}
export function remove(ctx:Ctx,name:string) {checkName(name,true); if(loadStrategy(ctx).name===name) throw new Error("cannot delete the active strategy"); const path=pathFor(ctx,name); if(!existsSync(path))throw new Error(`unknown strategy "${name}"`); rmSync(path); return {name,deleted:true};}
