import type {Ctx} from "../types";
import {CoreError} from "../core/errors";
import {loadStrategy,type Strategy} from "../config/strategy";
import {readTask} from "../tasks/store";
import type {Candidate} from "./types";
import {decisionHash} from "./engines";
import {getWork,observedUsageDelta} from "./work";
import {boundedJson,dispatchDatabase} from "./store";

interface ReviewEvidence {taskId:string;attempt:number;repo:string;kind:string|null;difficulty:string;runner:string;model:string|null;settings:string;accepted:boolean;durationS:number|null;usagePct:number|null;at:number;provenance:"human"|"requesting-agent"}
export function dispatchSettingsHash(strategy:Strategy,executor:string):string {
 const runner=strategy.runners[executor];
 return decisionHash({agent:runner?.agent,account:runner?.account,host:runner?.host,provider:strategy.providers[executor],dispatch:strategy.dispatch?.engine});
}
function evidence(ctx:Ctx,id:string,provenance:ReviewEvidence["provenance"]):ReviewEvidence|null {
 const work=getWork(ctx,id),task=readTask(ctx,id),attempt=task?.attempts.at(-1);
 if(!work||!task?.review||!attempt)return null;
 return{taskId:id,attempt:task.attempts.length,repo:task.brief.repo,kind:work.options.kind??task.kind,difficulty:work.options.difficulty,runner:attempt.executor,model:attempt.actualModel??null,settings:attempt.dispatchSettingsHash??"legacy-unknown",accepted:task.review.accepted,
  durationS:attempt.endedAt>=attempt.startedAt?attempt.endedAt-attempt.startedAt:null,
  usagePct:observedUsageDelta(attempt.usageAtStart,attempt.usageAtEnd),
  at:task.review.at,provenance};
}
export function recordWorkReview(ctx:Ctx,id:string,provenance:ReviewEvidence["provenance"]):void {
 const row=evidence(ctx,id,provenance);if(!row)return;
 dispatchDatabase(ctx).query("INSERT OR REPLACE INTO work_reviews(task_id,attempt,at,provenance,data) VALUES(?,?,?,?,?)").run(id,row.attempt,row.at,provenance,boundedJson(row));
}
function rows(ctx:Ctx):ReviewEvidence[]{
 const db=dispatchDatabase(ctx);
 return db.query<{data:string},[] >("SELECT data FROM work_reviews").all().flatMap(r=>{try{return[JSON.parse(r.data) as ReviewEvidence];}catch{return[];}})
  .filter(r=>r.provenance==="human"||r.provenance==="requesting-agent")
  .filter(r=>!db.query("SELECT 1 FROM work_learning_exclusions WHERE repo=?").get(r.repo))
  .filter(r=>r.at>(db.query<{at:number},[string]>("SELECT at FROM work_learning_reset WHERE repo=?").get(r.repo)?.at??0));
}
function aggregate(items:ReviewEvidence[]){
 const n=items.length,wins=items.filter(r=>r.accepted).length,p=n?wins/n:0,z=1.96;
 const center=n?(p+z*z/(2*n))/(1+z*z/n):0.5;
 const half=n?z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/(1+z*z/n):0.5;
 const durations=items.flatMap(r=>r.durationS===null?[]:[r.durationS]);const usage=items.flatMap(r=>r.usagePct===null?[]:[r.usagePct]);
 return{sampleCount:n,accepted:wins,successRate:p,uncertainty:half,confidenceLower:Math.max(0,center-half),confidenceUpper:Math.min(1,center+half),averageDurationS:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null,averageUsagePct:usage.length?usage.reduce((a,b)=>a+b,0)/usage.length:null,latestAt:Math.max(0,...items.map(r=>r.at))};
}
export function dispatchAnalytics(ctx:Ctx,filter:{repo?:string;kind?:string}={}){
 const reviews=rows(ctx).filter(r=>(!filter.repo||r.repo===filter.repo)&&(!filter.kind||r.kind===filter.kind));
 const groups=new Map<string,ReviewEvidence[]>();
 for(const r of reviews){const key=JSON.stringify([r.kind,r.difficulty,r.runner,r.model,r.settings]);groups.set(key,[...(groups.get(key)??[]),r]);}
 return{groups:[...groups].map(([key,items])=>{const[kind,difficulty,runner,model,settings]=JSON.parse(key) as [string|null,string,string,string|null,string];return{kind,difficulty,runner,model,settings,...aggregate(items)};}).sort((a,b)=>b.sampleCount-a.sampleCount),totalReviews:reviews.length,minimumSamples:loadStrategy(ctx).dispatch?.learning.minSamples??20,learningRevision:filter.repo?learningRevision(ctx,filter.repo):null};
}
export function learningRevision(ctx:Ctx,repo:string):number {
 return dispatchDatabase(ctx).query<{at:number},[string]>("SELECT at FROM work_learning_reset WHERE repo=?").get(repo)?.at??0;
}
export function applyLearnedFit(ctx:Ctx,strategy:Strategy,candidates:Candidate[],kind:string|null,difficulty:string):Candidate[]{
 const config=strategy.dispatch?.learning;if(!config?.enabled)return candidates;
 const reviews=rows(ctx).filter(r=>r.at>=ctx.now-config.maxAgeDays*86400),minimum=config.minSamples;
 return candidates.map(c=>{
  const model=c.actualModel;
  if(!model)return c;
  const settings=dispatchSettingsHash(strategy,c.runner);
  const comparable=reviews.filter(r=>r.kind===kind&&r.difficulty===difficulty&&r.runner===c.runner&&r.model===model&&r.settings===settings);
  if(comparable.length<minimum)return c;
  const a=aggregate(comparable);return{...c,learnedFit:{successRate:a.successRate,sampleCount:a.sampleCount,uncertainty:a.uncertainty}};
 });
}
export function resetLearning(ctx:Ctx,repo:string,excluded:boolean,expectRev:number):number {
 if(ctx.env.PACER_WORK_GRANT)throw new CoreError("not_allowed","Work grants cannot alter learning");
 const db=dispatchDatabase(ctx);
 return db.transaction(()=>{
  const current=learningRevision(ctx,repo);
  if(current!==expectRev)throw new CoreError("conflict","Learning controls changed; reload before resetting");
  const next=Math.max(ctx.now,current+0.001);
  db.query("INSERT OR REPLACE INTO work_learning_reset(repo,at) VALUES(?,?)").run(repo,next);
  if(excluded)db.query("INSERT OR IGNORE INTO work_learning_exclusions(repo) VALUES(?)").run(repo);
  else db.query("DELETE FROM work_learning_exclusions WHERE repo=?").run(repo);
  return next;
 }).immediate();
}
