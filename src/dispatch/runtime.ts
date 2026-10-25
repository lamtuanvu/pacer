import type { Ctx } from "../types";
import type { Strategy } from "../config/strategy";
import type { Status } from "../engine/status";
import type { TaskRecord } from "../tasks/types";
import { previewDispatch } from "../core/dispatch";
import type { Candidate, DispatchPreview } from "./types";
import { appendWorkEvent, boundedJson, dispatchDatabase } from "./store";
import { getWork, pendingDependencies } from "./work";
import { readTask } from "../tasks/store";

export async function resolveTaskDispatch(ctx:Ctx,task:TaskRecord,strategy:Strategy,status:Status,tried:ReadonlySet<string>):Promise<DispatchPreview>{
 const work=getWork(ctx,task.id)!;
 return previewDispatch(ctx,{repo:task.brief.repo,goal:task.brief.goal,kind:work.options.kind??task.kind??undefined,requirements:work.options.requirements,preferences:work.options.preferences,model:work.options.model},
  {strategy,status:async()=>status,taskId:task.id,includePlanner:work.options.allowDelegation,excludeCandidates:tried,difficulty:work.options.difficulty});
}
export function reserveDispatch(ctx:Ctx,id:string,candidate:Candidate,preview:DispatchPreview):boolean {
 const db=dispatchDatabase(ctx);return db.transaction(()=>{
  const work=getWork(ctx,id);if(!work||!["queued","running"].includes(readTask(ctx,id)?.state??"")||pendingDependencies(ctx,id).length)return false;
  if(work.options.expiresAt!==undefined&&work.options.expiresAt<=ctx.now)return false;
  const root=getWork(ctx,work.rootId)!;
  const running=db.query<{task_id:string},[string]>("SELECT n.task_id FROM work_nodes n JOIN tasks t ON t.id=n.task_id WHERE n.root_id=? AND t.state='running'").all(work.rootId).filter(r=>r.task_id!==id);
  if(running.length>=root.options.maxConcurrent)return false;
  let ancestor=work.parentId?getWork(ctx,work.parentId):null;
  while(ancestor){
   const descendants=db.query<{task_id:string},[string]>("WITH RECURSIVE subtree(id) AS (SELECT task_id FROM work_nodes WHERE task_id=? UNION ALL SELECT child.task_id FROM work_nodes child JOIN subtree ON child.parent_id=subtree.id) SELECT t.id AS task_id FROM subtree JOIN tasks t ON t.id=subtree.id WHERE t.state='running'").all(ancestor.taskId).filter(r=>r.task_id!==id);
   if(descendants.length>=ancestor.options.maxConcurrent)return false;
   ancestor=ancestor.parentId?getWork(ctx,ancestor.parentId):null;
  }
  const reservations=db.query<{task_id:string;pools:string;estimate:number},[]>("SELECT task_id,pools,estimate FROM work_reservations").all().filter(r=>r.task_id!==id);
  const reserved=new Map<string,number>();for(const r of reservations)for(const pool of JSON.parse(r.pools) as string[])reserved.set(pool,(reserved.get(pool)??0)+r.estimate);
  const headroom=candidate.headroom;
  if(headroom!==null&&candidate.poolIds.some(pool=>(reserved.get(pool)??0)+work.options.estimatePct>headroom-preview.request.config.reservePct))return false;
  if(candidate.headroom===null&&work.options.estimatePct>0)return false;
  db.query("INSERT OR REPLACE INTO work_reservations(task_id,root_id,runner,pools,estimate,at) VALUES(?,?,?,?,?,?)").run(id,work.rootId,candidate.runner,boundedJson(candidate.poolIds),work.options.estimatePct,ctx.now);
  const attempt=(readTask(ctx,id)?.attempts.length??0)+1;
  const uncertainty=preview.uncertainty.filter(message=>message!=="Preview uses cached observations and makes no reservation; dispatch may differ.");
  db.query("INSERT OR REPLACE INTO work_decisions(task_id,attempt,data) VALUES(?,?,?)").run(id,attempt,boundedJson({...preview,uncertainty,selectedCandidateId:candidate.id}));
  appendWorkEvent(ctx,id,"dispatch.reserved",{attempt,runner:candidate.runner,model:candidate.binding,inputHash:preview.inputHash,engine:preview.engine});return true;
 }).immediate();
}
export function releaseDispatch(ctx:Ctx,id:string):void {dispatchDatabase(ctx).query("DELETE FROM work_reservations WHERE task_id=?").run(id);}
export function selectedDispatchModel(ctx:Ctx,id:string):string|null|undefined{
 const row=dispatchDatabase(ctx).query<{data:string},[string]>("SELECT data FROM work_decisions WHERE task_id=? ORDER BY attempt DESC LIMIT 1").get(id);if(!row)return undefined;
 const preview=JSON.parse(row.data) as DispatchPreview & {selectedCandidateId?:string};if(preview.proposal?.state!=="ranked")return undefined;
 const selectedId=preview.selectedCandidateId??preview.proposal.choices[0].id;const candidate=preview.request.candidates.find(c=>c.id===selectedId);return candidate?.binding.kind==="exact"?candidate.binding.id:null;
}
