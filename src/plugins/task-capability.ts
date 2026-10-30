import {CoreError} from '../core/errors';
import type {Ctx} from '../types';
import {CallAuthority} from './authority';
import {ReadOwner} from './read-owner';
import {POLICY_CAPABILITY_METHODS} from './policy-protocol';

/** Reads use the same task projections as the public API; no raw storage capability. */
export async function answerTaskCapability(ctx:Ctx,method:string,params:unknown,owner?:CallAuthority|ReadOwner,transport?:{resultFits(result:unknown):boolean}):Promise<unknown> {
  if(!(owner instanceof CallAuthority)&&!(owner instanceof ReadOwner))throw new CoreError('capability_denied','task reads require an owning call or read owner');
  owner.assertGranted('tasks.read');
  if(owner.ctx.home!==ctx.home||owner.ctx.pacerHome!==ctx.pacerHome)throw new CoreError('capability_denied','task authority belongs to another host context');
  if(!transport)throw new CoreError('capability_denied','task reads require a captured transport envelope');
  const def=POLICY_CAPABILITY_METHODS[method];
  if(!def||!['capability.tasks.read','capability.tasks.list'].includes(method))throw new CoreError('capability_denied','not a task read');
  const parsed=def.params.safeParse(params);
  if(!parsed.success)throw new CoreError('invalid_input','invalid task read parameters');
  const input=parsed.data as {id?:string;states?:NonNullable<Parameters<typeof import('../tasks/store').listTasksWhere>[1]>['states'];limit?:number};
  // Projection modules reach API/core registries; load only after startup/admission.
  const [{authorizeWorkOperation},{taskDetail},{apiTasks},{listTasksWhere}]=await Promise.all([
    import('../core/work'),import('../core/task-detail'),import('../api/read-model/tasks'),import('../tasks/store'),
  ]);
  owner.assertGranted('tasks.read');
  const principal={...owner.readContext(),readOnly:true};
  authorizeWorkOperation(principal,method==='capability.tasks.read'?'task.get':'task.list',parsed.data);
  const result=method==='capability.tasks.read'?{task:await taskDetail(principal,input.id!)}:
    {tasks:apiTasks(principal,listTasksWhere(principal,{states:input.states,limit:input.limit??100}))};
  owner.assertGranted('tasks.read');
  authorizeWorkOperation(owner.readContext(),method==='capability.tasks.read'?'task.get':'task.list',parsed.data);
  if(transport&&!transport.resultFits(result))throw new CoreError('too_large','task result exceeds transport envelope');
  return result;
}
