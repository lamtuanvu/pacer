import {heading,span,wrap} from "../frame";
import type {Row,TaskDetail,ScreenCtx} from "./types";
import {COORDINATES,taskStatus} from "../../view-model/words";

export function workRows(ctx:ScreenCtx,detail:TaskDetail,width:number):Row[]{
 if(!detail.work)return[];
 const tree=detail.workTree;
 const rows:Row[]=[{line:heading(ctx.theme,"Work tree")}];
 if(detail.work.allowDelegation)for(const line of wrap(COORDINATES,width,2))rows.push({line:[span(line,{fg:"muted"})]});
 if(!tree)return[...rows,{line:[span("Work history unavailable",{fg:"muted"})]}];
 rows.push({line:[span(`${tree.totals.tasks} tasks · ${tree.totals.running} running · ${tree.totals.queued} queued · ${Math.round(tree.totals.executionSeconds)} s recorded`,{fg:"muted"})]});
 const duration=(value:number|null|undefined)=>value==null?"unknown":`${Math.round(value)} s`;
 rows.push({line:[span(`Dependency wait ${duration(tree.totals.dependencyWaitSeconds)} · child wait ${duration(tree.totals.childWaitSeconds)} · capacity wait ${duration(tree.totals.capacityWaitSeconds)}`,{fg:"muted"})]});
 for(const pool of tree.totals.usagePools??[])rows.push({line:[span(`${pool.account}: ${pool.observedDeltaPct===null?"usage unknown":`${pool.observedDeltaPct.toFixed(1)}% observed shared usage`}${pool.unknownAttempts?` · ${pool.unknownAttempts} unmeasured`:""}`,{fg:"muted"})]});
 for(const node of tree.nodes){
  const prefix=`${"  ".repeat(Math.min(node.depth,6))}${node.depth?"↳ ":""}`;
  const status=`${taskStatus(node).label}${node.review?node.review.accepted?" · accepted":" · rejected":""}`;
  const text=`${prefix}${node.title} · ${status}${node.model?` · requested ${node.model}`:" · model unknown"}${node.actualModel?` · observed ${node.actualModel}`:""}`;
  for(const line of wrap(text,width,2))rows.push({line:[span(line)]});
  if(node.dependencies.length)rows.push({line:[span(`${"  ".repeat(Math.min(node.depth+1,7))}depends on ${node.dependencies.join(", ")}`,{fg:"secondary"})]});
  if(node.retryEligibility?.reason&&["failed","partial","limit","stopped","needs_input"].includes(node.state))rows.push({line:[span(`${"  ".repeat(Math.min(node.depth+1,7))}Retry unavailable: ${node.retryEligibility.reason}`,{fg:"muted"})]});
  for(const decision of node.decisions){
   const choice=decision.proposal?.choices?.find(c=>c.id===decision.selectedCandidateId)??decision.proposal?.choices?.[0];
   const attempt=node.attempts[decision.attempt-1];
   const text=`${"  ".repeat(Math.min(node.depth+1,7))}attempt ${decision.attempt}: ${decision.engine.id} · ${choice?.reason??"no selection"} · requested ${attempt?.model??"unknown"} · observed ${attempt?.actualModel??"unknown"}${decision.fallback?` · fallback ${decision.fallback.reason}`:""}`;
   for(const line of wrap(text,width,2))rows.push({line:[span(line,{fg:"secondary"})]});
  }
 }
 return rows;
}
