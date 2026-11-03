import {createHash} from 'node:crypto';
import {CoreError} from '../core/errors';
import {loadStrategy} from '../config/strategy';
import {readTask} from '../tasks/store';
import {prepareCreationAdmission,admissionLifetime} from '../tasks/creation-admission';
import {applyPolicy} from '../plugins/policy';
import {taskAgentWorkspace} from './agents-state';
import type {Ctx} from '../types';
import type {StoredAgentSession} from './agents';

/** An appended conversation may restrict routing, but cannot move its owner,
 * checkout, kind or selected account. Policy runs before all mutation locks. */
export async function prepareAgentAdmission(ctx:Ctx,session:StoredAgentSession) {
 const task=readTask(ctx,session.task_id);
 if(!task)throw new CoreError('unknown_task','Unknown session task');
 const contextFingerprint=()=>createHash('sha256').update(JSON.stringify({
  task:readTask(ctx,session.task_id),strategy:loadStrategy(ctx),env:ctx.env,
  session:{id:session.id,attempt:session.attempt,executor:session.executor,cwd:session.cwd,request:session.request},
 })).digest('hex');
 const input={goal:session.request,repo:session.cwd,kind:task.kind,
  requestedExecutor:session.executor,placement:'current' as const};
 const admission=await prepareCreationAdmission(ctx,input,{
  contextFingerprint,eligibleRunnerIds:[session.executor],allowedPlacements:['current'],
  strictAmendments:true,validateAmend:next=>next.kind===input.kind&&next.placement===input.placement&&next.requestedExecutor===session.executor,
  validateCurrent:next=>{
   if(next.kind!==input.kind||next.placement!=='current'||next.requestedExecutor!==session.executor)throw new CoreError('not_allowed','Policy cannot change an appended session owner or workspace');
  },
  additionalDirectories:[task.brief.repo],taskLock:task.id,
  validateArtifacts:async()=>{
   const current=readTask(ctx,task.id);
   if(!current||await taskAgentWorkspace(ctx,current)!==session.cwd)throw new CoreError('conflict','Session workspace changed during admission');
  },
 });
 const route=await applyPolicy(ctx,'route',{taskId:task.id,candidates:[session.executor]},
  {contextFingerprint,strictAmendments:true,...admissionLifetime(ctx)});
 if(route.params.decision!=='route'||!route.params.input.candidates.includes(session.executor))throw new CoreError('not_allowed','Policy excluded the selected session executor');
 return {
  revalidate:()=>{admission.revalidate();route.revalidate();},
  consume<T>(effect:()=>T) {
   return admission.consume(()=>{route.revalidate();return effect();});
  },
 };
}
