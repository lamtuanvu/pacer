import {expect,test} from 'bun:test';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {policyGateFixture} from './fixtures/policy-host';
import {gitRepo,realRun} from './helpers';
import {createTask,readTask,updateTask} from '../src/tasks/store';
import {createAgentSession,changeAgentSession,listAgentSessions} from '../src/session/agents';
import type {RunSpec} from '../src/supervisor/run';

function fixture(verdict:unknown={verdict:'allow'}) {
 const f=policyGateFixture(verdict,0,gitRepo());f.ctx.run=realRun;
 const main=join(f.dir,'main.ts');
 writeFileSync(main,readFileSync(main,'utf8').replace('result=s.verdict;','result=s.byDecision?.[r.params.decision]??s.verdict;'));
 const task=createTask(f.ctx,{brief:{goal:'Parent',repo:f.repo},kind:null,requestedExecutor:'codex',timeoutS:60});
 updateTask(f.ctx,task.id,t=>{t.state='done';t.backend='direct';t.worktree=f.repo;t.review={accepted:true,kind:null,note:null,at:f.ctx.now};});
 const specs:RunSpec[]=[];
 const deps={launch:async(_ctx:any,s:any)=>({argv:['fixture'],cwd:s.cwd,env:{},identity:s.nativeId??'native-id'}),start:(spec:RunSpec)=>{specs.push(spec);return {pid:12345};}};
 const input={task_id:task.id,request_id:'policy-agent',executor:'codex',request:'Review parent'};
 const verdictIs=(verdict:unknown,delay=0)=>writeFileSync(join(f.dir,'settings.json'),JSON.stringify({verdict,delay}));
 return {...f,task,specs,deps,input,verdictIs};
}
test('added creation veto leaves parent checks/review and session registry untouched',async()=>{
 const f=fixture({verdict:'veto',reason:'blocked'}),before=readTask(f.ctx,f.task.id);
 await expect(createAgentSession(f.ctx,f.input,f.deps)).rejects.toMatchObject({code:'not_allowed'});
 expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(listAgentSessions(f.ctx)).toEqual([]);expect(f.specs).toHaveLength(0);
});

async function target(action:'create'|'retry'|'resume') {
 const f=fixture();
 const s=action==='create'?undefined:await createAgentSession(f.ctx,f.input,f.deps);
 const run=(deps=f.deps)=>s?changeAgentSession(f.ctx,{task_id:s.task_id,id:s.id,expect_rev:s.rev},action as 'retry'|'resume',deps):createAgentSession(f.ctx,f.input,deps);
 return {...f,run,s};
}
for(const action of ['create','retry','resume'] as const) {
 test(`added ${action} closed unavailable policy refuses before mutation`,async()=>{
  const f=await target(action),before=readTask(f.ctx,f.task.id),count=f.specs.length;
  writeFileSync(join(f.ctx.pacerHome,'strategy.yaml'),JSON.stringify({...f.config,plugins:{...f.config.plugins,installed:{'fx-policy':{version:'1.0.0',capabilities:[],policy:true}}}}));
  writeFileSync(join(f.dir,'pacer-plugin.json'),'{invalid manifest');
  await expect(f.run()).rejects.toMatchObject({code:'not_allowed'});
  expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(f.specs).toHaveLength(count);
 });
 test(`added ${action} rejects unsupported amendments even in open mode`,async()=>{
  const f=await target(action),before=readTask(f.ctx,f.task.id),count=f.specs.length;
  writeFileSync(join(f.ctx.pacerHome,'strategy.yaml'),JSON.stringify({...f.config,plugins:{...f.config.plugins,policy:{mode:'open'}}}));
  for(const amend of [{kind:'tests'},{placement:'new'},{requestedExecutor:'claude-code'}]) {
   f.verdictIs({verdict:'amend',amend});
   await expect(f.run()).rejects.toMatchObject({code:'not_allowed'});
   expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(f.specs).toHaveLength(count);
  }
 });
 test(`added ${action} honors route exclusion without changing attempts`,async()=>{
  const f=await target(action),before=readTask(f.ctx,f.task.id),count=f.specs.length;
  writeFileSync(join(f.dir,'settings.json'),JSON.stringify({verdict:{verdict:'allow'},delay:0,byDecision:{route:{verdict:'amend',amend:{exclude:['codex']}}}}));
  await expect(f.run()).rejects.toMatchObject({code:'not_allowed'});
  expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(f.specs).toHaveLength(count);
 });
 test(`added ${action} supports identity-preserving delegate and route amendments`,async()=>{
  const f=await target(action);
  writeFileSync(join(f.dir,'settings.json'),JSON.stringify({verdict:{verdict:'allow'},delay:0,byDecision:{delegate:{verdict:'amend',amend:{kind:null,placement:'current',requestedExecutor:'codex'}},route:{verdict:'amend',amend:{exclude:[]}}}}));
  const result=await f.run();
  expect(result.task_id).toBe(f.task.id);expect(result.cwd).toContain(f.repo);expect(result.executor).toBe('codex');
 });
 test(`added ${action} revalidates policy after native preparation before invalidation/spawn`,async()=>{
  const f=await target(action),before=readTask(f.ctx,f.task.id),count=f.specs.length;
  await expect(f.run({...f.deps,launch:async(...args)=>{
   const launch=await f.deps.launch(...args);
   writeFileSync(join(f.ctx.pacerHome,'strategy.yaml'),JSON.stringify({...f.config,plugins:{...f.config.plugins,policy:{mode:'open'}}}));
   return launch;
  }})).rejects.toMatchObject({code:'conflict'});
  expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(f.specs).toHaveLength(count);
 });
}
test('duplicate added creation replays without policy or launch, concurrent duplicates launch once',async()=>{
 const f=fixture();
 const [a,b]=await Promise.all([createAgentSession(f.ctx,f.input,f.deps),createAgentSession(f.ctx,f.input,f.deps)]);
 expect(a.id).toBe(b.id);expect(f.calls()).toHaveLength(2);expect(f.specs).toHaveLength(1);
 f.verdictIs({verdict:'veto'});
 expect((await createAgentSession(f.ctx,f.input,f.deps)).id).toBe(a.id);expect(f.calls()).toHaveLength(2);
});
test('policy waits hold no task mutation lock; a changed parent invalidates admission',async()=>{
 const f=fixture();f.verdictIs({verdict:'allow'},200);
 const pending=createAgentSession(f.ctx,f.input,f.deps).then(value=>({value}),error=>({error}));
 const deadline=Date.now()+3000;while(!f.calls().length&&Date.now()<deadline)await Bun.sleep(10);
 expect(f.calls()).toHaveLength(1);
 updateTask(f.ctx,f.task.id,t=>{t.brief.context='changed during policy';});
 const result=await pending;expect(result).toMatchObject({error:{code:'conflict'}});
 expect(readTask(f.ctx,f.task.id)?.review?.accepted).toBe(true);expect(f.specs).toHaveLength(0);expect(listAgentSessions(f.ctx)).toEqual([]);
});
test('native preparation cannot replace the checkout authorized by policy',async()=>{
 const f=fixture(),before=readTask(f.ctx,f.task.id),replacement=gitRepo(),saved=f.repo+'-saved';
 let swapped=false;
 try {
  await expect(createAgentSession(f.ctx,f.input,{...f.deps,launch:async(...args)=>{
   const launch=await f.deps.launch(args[0],args[1]);
   renameSync(f.repo,saved);renameSync(replacement,f.repo);swapped=true;
   return launch;
  }})).rejects.toMatchObject({code:'conflict'});
  expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(f.specs).toHaveLength(0);expect(listAgentSessions(f.ctx)).toEqual([]);
 }finally{if(swapped){renameSync(f.repo,replacement);renameSync(saved,f.repo);}}
});
for(const action of ['retry','resume'] as const)test(`added ${action} veto preserves attempt and parent`,async()=>{
 const f=fixture(),s=await createAgentSession(f.ctx,f.input,f.deps);
 const before=readTask(f.ctx,f.task.id),sessions=listAgentSessions(f.ctx);f.verdictIs({verdict:'veto',reason:'blocked'});
 await expect(changeAgentSession(f.ctx,{task_id:s.task_id,id:s.id,expect_rev:s.rev},action,f.deps)).rejects.toMatchObject({code:'not_allowed'});
 expect(readTask(f.ctx,f.task.id)).toEqual(before);
 expect(listAgentSessions(f.ctx).map(({ownerTask,...session})=>session)).toEqual(sessions.map(({ownerTask,...session})=>session));expect(f.specs).toHaveLength(1);
});
