import {expect,test} from 'bun:test';
import {fakeCtx,tmpDir} from './helpers';
import {realpathSync} from 'node:fs';
import {ReadOwner} from '../src/plugins/read-owner';
import {answerTaskCapability} from '../src/plugins/task-capability';
import {createTask,updateTask} from '../src/tasks/store';
import {taskDetail} from '../src/core/task-detail';
import type {PluginManifest} from '../src/plugins/protocol';
const fits={resultFits:()=>true};
const manifest:PluginManifest={id:'policy-test',publisher:'pacer',version:'1.0.0',host:'^1.6',capabilities:[{name:'tasks.read'},{name:'events.subscribe'}],contributes:{policy:{}},reentrant:true,tier:'free'};
function setup(){const ctx=fakeCtx({home:realpathSync(tmpDir())});let current=true;const owner=new ReadOwner(ctx,manifest,['tasks.read','events.subscribe'],()=>current);return {ctx,owner,retire:()=>{current=false;}};}
test('read owners are generation-bound, explicitly read-only and revocable',()=>{
 const {owner,retire}=setup();expect(owner.token).toBeString();owner.assertGranted('tasks.read');
 for(const effect of ['fs.read','fs.write','process.spawn','net.http','secrets.resolve','usage.state'])expect(()=>owner.assertGranted(effect)).toThrow('read');
 retire();expect(()=>owner.assertGranted('tasks.read')).toThrow('generation');
 const other=setup().owner;other.revoke();expect(()=>other.assertGranted('tasks.read')).toThrow('retired');
});
test('task projection requires explicit declared and granted generation authority',async()=>{
 const {ctx,owner}=setup();await expect(answerTaskCapability(ctx,'capability.tasks.list',{},undefined)).rejects.toMatchObject({code:'capability_denied'});
 const denied=new ReadOwner(ctx,manifest,[],()=>true);await expect(answerTaskCapability(ctx,'capability.tasks.list',{},denied)).rejects.toMatchObject({code:'capability_denied'});
 const undeclared=new ReadOwner(ctx,{...manifest,capabilities:[]},['tasks.read'],()=>true);expect(()=>undeclared.assertGranted('tasks.read')).toThrow();
 owner.revoke();await expect(answerTaskCapability(ctx,'capability.tasks.list',{},owner)).rejects.toMatchObject({code:'capability_denied'});
});
test('task detail uses canonical unknown-task behavior and public projection',async()=>{
 const {ctx,owner}=setup();const task=createTask(ctx,{brief:{goal:'synthetic public goal',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 expect(await answerTaskCapability(ctx,'capability.tasks.read',{id:task.id},owner,fits)).toEqual({task:await taskDetail(ctx,task.id)});
 await expect(answerTaskCapability(ctx,'capability.tasks.read',{id:'missing'},owner,fits)).rejects.toMatchObject({code:'unknown_task'});
});
test('task states are filtered before limit and oversize replies fail explicitly',async()=>{
 const {ctx,owner}=setup();const queued=createTask(ctx,{brief:{goal:'queued',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 for(let n=0;n<4;n++){const t=createTask(ctx,{brief:{goal:'other',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});updateTask(ctx,t.id,t=>{t.state='done';});}
 const result=await answerTaskCapability(ctx,'capability.tasks.list',{states:['queued'],limit:1},owner,fits) as {tasks:{id:string}[]};expect(result.tasks.map(t=>t.id)).toEqual([queued.id]);
 await expect(answerTaskCapability(ctx,'capability.tasks.list',{},owner,{resultFits:()=>false})).rejects.toMatchObject({code:'too_large'});
});

test('foreign homes, missing envelope and ambient work grants cannot widen task reads',async()=>{
 const {ctx,owner}=setup(),foreign=fakeCtx();
 await expect(answerTaskCapability(foreign,'capability.tasks.list',{},owner,fits)).rejects.toMatchObject({code:'capability_denied'});
 await expect(answerTaskCapability(ctx,'capability.tasks.list',{},owner)).rejects.toMatchObject({code:'capability_denied'});
 const grantCtx={...ctx,env:{...ctx.env,PACER_WORK_GRANT:'invalid-synthetic-grant'}};
 const grantOwner=new ReadOwner(grantCtx,manifest,['tasks.read'],()=>true);
 await expect(answerTaskCapability(grantCtx,'capability.tasks.list',{},grantOwner,fits)).rejects.toMatchObject({code:'not_allowed'});
 await expect(answerTaskCapability(ctx,'capability.tasks.list',{},grantOwner,fits)).rejects.toMatchObject({code:'not_allowed'});
});

test('valid work grants expire before reads and during awaited public projections',async()=>{
 const {registerWork,issueWorkGrant,authorizeWorkGrant}=await import('../src/dispatch/work');
 for(const during of [false,true]) {
  let clock=1000;
  const ctx=fakeCtx({home:realpathSync(tmpDir()),run:async()=>{if(during)clock=3000;return {code:127,stdout:'',stderr:''};}});
  const task=createTask(ctx,{brief:{goal:'scoped root',repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:1});
  registerWork(ctx,task.id,{allowDelegation:true});updateTask(ctx,task.id,t=>{t.state='running';});
  const token=issueWorkGrant(ctx,task.id,1);expect(authorizeWorkGrant(ctx,token).taskId).toBe(task.id);
  const principal={...ctx,env:{PACER_WORK_GRANT:token,PACER_ROLE:'executor'}};
  const owner=new ReadOwner(principal,manifest,['tasks.read'],()=>true,()=>clock);
  if(!during)clock=3000;
  await expect(answerTaskCapability(ctx,'capability.tasks.read',{id:task.id},owner,fits)).rejects.toMatchObject({code:'not_allowed',message:'Expired or revoked work grant'});
 }
});
