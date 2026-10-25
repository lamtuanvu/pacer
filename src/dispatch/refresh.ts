import type {Ctx} from "../types";
import {loadStrategy} from "../config/strategy";
import {computeStatus} from "../engine/status";
import {pluginRegistry} from "../plugins";
import {CoreError} from "../core/errors";
import {decisionHash} from "./engines";
import {buildModelInventory} from "./inventory";
import {collectObservations,statusObservationAdapter} from "./observations";
import {pluginObservationAdapter} from "./plugin-adapters";
import {dispatchDatabase,boundedJson} from "./store";
import {observationSchema,type Observation,type ObservationScope} from "./types";

export function storedObservations(ctx:Ctx):Observation[]{
 const db=dispatchDatabase(ctx);
 return db.query<{data:string},[] >("SELECT data FROM work_observations ORDER BY at DESC LIMIT 2048").all().flatMap(row=>{
  try{const parsed=observationSchema.safeParse(JSON.parse(row.data));return parsed.success&&parsed.data.expiresAt>ctx.now?[parsed.data]:[];}catch{return[];}
 });
}
export async function refreshObservations(ctx:Ctx,filter:{runner?:string;force?:boolean}={}){
 if(ctx.env.PACER_WORK_GRANT)throw new CoreError("not_allowed","Work grants cannot refresh observations");
 const strategy=loadStrategy(ctx),db=dispatchDatabase(ctx);
 const scopes:ObservationScope[]=Object.values(strategy.runners).filter(r=>!filter.runner||r.id===filter.runner).flatMap(r=>[
  {runner:r.id,account:r.account},...buildModelInventory(strategy,[],ctx.now).filter(m=>m.runner===r.id).map(m=>({runner:r.id,account:r.account,binding:m.binding})),
 ]);
 if(filter.runner&&!scopes.length)throw new CoreError("invalid_input","Unknown runner");
 const now=Date.now()/1000,key=filter.runner??"all";
 const previous=db.query<{retry_at:number},[string]>("SELECT retry_at FROM work_refresh WHERE scope=?").get(key);
 if(!filter.force&&previous&&previous.retry_at>now)return{state:"backoff",retryAt:previous.retry_at,observations:0};
 const status=await computeStatus({...ctx,now},strategy);
 const plugins=pluginRegistry(ctx).list(ctx).filter(p=>p.enabled&&p.contributes.includes("observation"));
 const observations=await collectObservations({...ctx,now},[statusObservationAdapter(status),...plugins.map(p=>pluginObservationAdapter(p.id))],scopes,strategy.dispatch?.timeoutMs??1000);
 const errors=observations.filter(o=>o.state==="error").length;
 const failures=errors?Math.min(8,(db.query<{failures:number},[string]>("SELECT failures FROM work_refresh WHERE scope=?").get(key)?.failures??0)+1):0;
 db.transaction(()=>{
  for(const o of observations){if(o.state!=="known")continue;const id=decisionHash({source:o.source,scope:o.scope,method:o.method});db.query("INSERT OR REPLACE INTO work_observations(id,at,data) VALUES(?,?,?)").run(id,o.observedAt,boundedJson(o));}
  db.query("INSERT OR REPLACE INTO work_refresh(scope,attempted,retry_at,failures) VALUES(?,?,?,?)").run(key,now,now+(failures?Math.min(3600,30*2**failures):60),failures);
 }).immediate();
 return{state:errors?"partial":"ok",observations:observations.length,known:observations.filter(o=>o.state==="known").length,errors,retryAt:now+(failures?Math.min(3600,30*2**failures):60)};
}
export function listDispatchModels(ctx:Ctx){
 const strategy=loadStrategy(ctx),observations=storedObservations(ctx);
 const declared=buildModelInventory(strategy,observations,ctx.now);
 const advertised=observations.filter(o=>o.method==="models"&&o.state==="known").flatMap(o=>(o.value?.models??[]).map(m=>({source:o.source,runner:o.scope.runner,account:o.scope.account,model:m,authorized:declared.some(d=>d.runner===o.scope.runner&&d.binding.kind==="exact"&&d.binding.id===m.id)})));
 return{models:declared,advertised,observedAt:observations.length?Math.max(...observations.map(o=>o.observedAt)):null};
}
