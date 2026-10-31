import { expect, test } from 'bun:test';
import { fakeCtx, gitRepo } from './helpers';
import { createTask, listTasks, readTask } from '../src/tasks/store';
import { createAgentSession, listAgentSessions, getAgentSession, changeAgentSession, agentSessionDirectory } from '../src/session/agents';
import type { RunSpec } from '../src/supervisor/run';

function fixture() {
  const ctx = fakeCtx({run:realRun}), repo = gitRepo();
  mkdirSync(ctx.pacerHome,{recursive:true});
  writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  codex: {usage: reactive}\n');
 const task = createTask(ctx,{brief:{goal:'Implement',repo},kind:null,requestedExecutor:'codex',timeoutS:3600});
 updateTask(ctx,task.id,t=>{t.backend='direct';t.worktree=repo;t.placement={requested:'current',mode:'current'};});
 const specs:RunSpec[]=[];
 const deps={launch:async (_ctx:any, session:any, dir:string, resume:boolean)=>({argv:['fixture-agent',session.request],cwd:session.cwd,env:{HOME:ctx.home,PACER_HOME:ctx.pacerHome},identity:resume?session.nativeId:`native-${session.id}-${session.attempt}`}),start:(spec:RunSpec)=>{specs.push(spec);return {pid:12345};}};
 const input={task_id:task.id,request_id:'first',executor:'codex',request:'Review'};
 return {ctx,task,specs,deps,input};
}
test('two persistent interactive sessions belong to one task without creating tasks',async()=>{
 const {ctx,task,specs,deps,input}=fixture();
 const [a,b]=await Promise.all([createAgentSession(ctx,input,deps),createAgentSession(ctx,{...input,request_id:'second'},deps)]);
 expect(a.id).not.toBe(b.id);expect(a.task_id).toBe(task.id);expect(b.task_id).toBe(task.id);
 expect(a.nativeId).not.toBe(b.nativeId);expect(specs[0]!.dir).not.toBe(specs[1]!.dir);
 expect(listTasks(ctx,100)).toHaveLength(1);expect(readTask(ctx,task.id)?.id).toBe(task.id);
 expect(listAgentSessions({...ctx},task.id).map(s=>s.id)).toEqual([a.id,b.id]);
 expect((await createAgentSession(ctx,input,deps)).id).toBe(a.id);expect(specs).toHaveLength(2);
 await expect(createAgentSession(ctx,{...input,request:'Different'},deps)).rejects.toMatchObject({code:'conflict'});
 expect(()=>getAgentSession(ctx,'other-task',a.id)).toThrow();
});
test('end, fresh retry and native resume affect only the selected session and retain attempts',async()=>{
 const {ctx,task,specs,deps,input}=fixture();
 const a=await createAgentSession(ctx,input,deps),b=await createAgentSession(ctx,{...input,request_id:'second'},deps);
 const stopped=await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);
 expect(stopped.state).toBe('ended');expect(getAgentSession(ctx,task.id,b.id).rev).toBe(b.rev);expect(getAgentSession(ctx,task.id,b.id).attempt).toBe(1);
 await expect(changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'retry',deps)).rejects.toMatchObject({code:'conflict'});
 const resumed=await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:stopped.rev},'resume',deps);
 expect(resumed.nativeId).toBe(a.nativeId);expect(resumed.attempt).toBe(2);
 const stoppedAgain=await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:resumed.rev},'end',deps);
 const retried=await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:stoppedAgain.rev},'retry',deps);
 expect(retried.nativeId).not.toBe(a.nativeId);expect(retried.attempt).toBe(3);
 expect(specs).toHaveLength(4);expect(agentSessionDirectory(ctx,task.id,a.id,1)).toBe(specs[0]!.dir);
});
test('failed starts remain discoverable and executor contexts cannot create sessions',async()=>{
 const {ctx,task,deps,input}=fixture();
 const failed=await createAgentSession(ctx,input,{...deps,start:()=>({error:'launch failed'})});
 expect(failed.state).toBe('failed');expect(listAgentSessions(ctx,task.id)[0]!.id).toBe(failed.id);
 await expect(createAgentSession({...ctx,env:{...ctx.env,PACER_ROLE:'executor'}},{...input,request_id:'denied'},deps)).rejects.toMatchObject({code:'not_allowed'});
 expect(listTasks(ctx,100)).toHaveLength(1);
});

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRun } from '../src/supervisor/run';
import { startServer } from '../src/serve/http';
import { FrameType, wire, WireDecoder } from '../src/session/framing';
import { runningWork, stopRunningWork } from '../src/service/running-work';
import { agentWorkspaceBusy, activeAgentSessions } from '../src/session/agents-state';
import { slotUse } from '../src/engine/slots';
import { taskReview, taskStop, settleLiveReleases } from '../src/tasks/api';
import { cleanTask } from '../src/tasks/cleanup';
import { updateTask } from '../src/tasks/store';

async function until(check:()=>boolean,ms=5000) {
 const deadline=Date.now()+ms;
 while(!check()){if(Date.now()>deadline)throw Error('session fixture deadline');await Bun.sleep(20);}
}
function liveFixture(){
 const f=fixture();f.ctx.run=realRun;
 const deps={launch:async(_ctx:any,s:any)=>({argv:['/bin/sh','-c','printf "READY\\n"; while IFS= read -r line; do printf "RECEIVED:%s\\n" "$line"; done'],cwd:s.cwd,env:{...process.env,HOME:f.ctx.home,PACER_HOME:f.ctx.pacerHome,PACER_ROLE:'executor',PACER_LOGIN_ENV:'off'},identity:`native-${s.id}`})};
 return {...f,deps};
}
async function connect(url:string,token:string,label:string){
 const ws=new WebSocket(url,{headers:{authorization:`Bearer ${token}`}} as any);ws.binaryType='arraybuffer';
 const messages:any[]=[],output:Buffer[]=[];
 ws.onmessage=e=>{if(typeof e.data==='string')messages.push(JSON.parse(e.data));else for(const f of new WireDecoder().push(Buffer.from(e.data)))if(f.type===FrameType.output)output.push(f.data);};
 await Promise.race([new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=reject;}),Bun.sleep(3000).then(()=>{throw Error('connect deadline');})]);
 ws.send(JSON.stringify({type:'hello',v:1,client:'app',label,cols:80,rows:24}));
 await until(()=>messages.some(m=>m.type==='snapshot'));
 return {ws,messages,output};
}

test('real PTY sessions isolate controllers/input, reconnect, retain old attempts, reserve checkout, and stop independently',async()=>{
 const {ctx,task,input,deps}=liveFixture();
 const sessions:Awaited<ReturnType<typeof createAgentSession>>[]=[],sockets:WebSocket[]=[];
 let http=startServer(()=>ctx,{port:0,pumpMs:3600000});
 try{
  for(const request_id of ['real-one','real-two'])sessions.push(await createAgentSession(ctx,{...input,request_id},deps));
  const [a,b]=sessions as [typeof sessions[number],typeof sessions[number]];
  await until(()=>sessions.every(s=>{try{return readFileSync(join(agentSessionDirectory(ctx,task.id,s.id),'stdout'),'utf8').includes('READY');}catch{return false;}}));
  expect(getAgentSession(ctx,task.id,a.id).live).toBe(true);expect(getAgentSession(ctx,task.id,b.id).live).toBe(true);
  expect(activeAgentSessions(ctx)).toHaveLength(2);expect(agentWorkspaceBusy(ctx,a.cwd)).toBe(true);expect(agentWorkspaceBusy(ctx,a.cwd,task.id)).toBe(false);
  expect(slotUse([],ctx)).toMatchObject({local:2,byExecutor:{codex:2}});
  expect((await runningWork(ctx)).sessions.filter(s=>s.kind==='agent').map(s=>s.id).sort()).toEqual([a.id,b.id].sort());
  expect(()=>taskReview(ctx,task.id,true)).toThrow('End this task');
  // The cleanup guard applies even if the parent has already settled.
  updateTask(ctx,task.id,t=>{t.state='done';t.review={accepted:true,kind:null,note:null,at:ctx.now} as any;});
  const cleaned=await cleanTask(ctx,task.id,{force:true});expect(cleaned.kept.some(k=>k.reason.includes('active agent session'))).toBe(true);
  let base=`ws://127.0.0.1:${http.port}`;
  const first=await connect(base+a.attach.ws,http.token,'A');sockets.push(first.ws);
  const second=await connect(base+b.attach.ws,http.token,'B');sockets.push(second.ws);
  first.ws.send(JSON.stringify({type:'take'}));second.ws.send(JSON.stringify({type:'take'}));
  await until(()=>first.messages.some(m=>m.type==='control'&&m.you)&&second.messages.some(m=>m.type==='control'&&m.you));
  first.ws.send(new Uint8Array(wire(FrameType.input,Buffer.from('ONLY_A\r'))));
  await until(()=>Buffer.concat(first.output).toString().includes('RECEIVED:ONLY_A'));
  expect(Buffer.concat(second.output).toString()).not.toContain('ONLY_A');
  http.stop();http=startServer(()=>({...ctx}),{port:0,pumpMs:3600000});base=`ws://127.0.0.1:${http.port}`;
  const reconnected=await connect(base+a.attach.ws,http.token,'Restored A');sockets.push(reconnected.ws);
  expect(reconnected.messages.find(m=>m.type==='snapshot').screenAnsi).toContain('ONLY_A');
  expect(getAgentSession({...ctx},task.id,b.id).live).toBe(true);
  const oldA=agentSessionDirectory(ctx,task.id,a.id);
  const stopped=await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);
  expect(stopped.live).toBe(false);expect(getAgentSession(ctx,task.id,b.id).live).toBe(true);
  // Reconnect to the exact ended attempt replays its output, without control.
  const replay=await connect(base+a.attach.ws,http.token,'Replay');sockets.push(replay.ws);
  await until(()=>replay.messages.some(m=>m.type==='exit'));
  expect(replay.messages.some(m=>m.type==='snapshot')).toBe(true);
  const retried=await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:stopped.rev},'retry',deps);
  expect(retried.attempt).toBe(2);expect(agentSessionDirectory(ctx,task.id,a.id)).not.toBe(oldA);
  expect(readFileSync(join(oldA,'stdout'),'utf8')).toContain('RECEIVED:ONLY_A');
  await until(()=>{try{return readFileSync(join(agentSessionDirectory(ctx,task.id,a.id),'stdout'),'utf8').includes('READY');}catch{return false;}});
  const stopReport=await stopRunningWork(ctx);expect(stopReport.skipped).toEqual([]);
  expect(getAgentSession(ctx,task.id,a.id).live).toBe(false);expect(getAgentSession(ctx,task.id,b.id).live).toBe(false);
 }finally{
  for(const socket of sockets)socket.close();
  for(const s of sessions){try{const current=getAgentSession(ctx,task.id,s.id);await changeAgentSession(ctx,{task_id:task.id,id:s.id,expect_rev:current.rev},'end',deps);}catch{}}
  http.stop();await settleLiveReleases();
 }
},25000);

import { agentChecksPending, settleAgentSessionChecks, stopAgentSessionChecks } from '../src/session/agents-checks';
import { withLoginIndicators, realRun } from './helpers';
import { mkdirSync } from 'node:fs';

test('task checks wait for every session, invalidate old verdicts, and run only once for the final generation',async()=>{
 const {ctx,task,input,deps}=liveFixture();
 updateTask(ctx,task.id,t=>{
  t.state='done';t.brief.acceptance='echo verified >> checks-count; echo "1 passed"';
  t.result={status:'done',executor:'codex',model:null,report:'Original output',backend:'direct',files:'old',acceptance:{cmd:t.brief.acceptance,passed:true,tail:'Old pass'}};
  t.review={accepted:true,kind:null,note:null,at:ctx.now};
 });
 const a=await createAgentSession(ctx,{...input,request_id:'checks-a'},deps),b=await createAgentSession(ctx,{...input,request_id:'checks-b'},deps);
 try{
  expect(readTask(ctx,task.id)?.result?.acceptance).toBeUndefined();expect(readTask(ctx,task.id)?.review).toBeUndefined();
  await settleAgentSessionChecks(ctx);expect(agentChecksPending(ctx,task.id)).toBe(true);
  await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);
  await settleAgentSessionChecks(ctx);expect(agentChecksPending(ctx,task.id)).toBe(true);
  await changeAgentSession(ctx,{task_id:task.id,id:b.id,expect_rev:b.rev},'end',deps);
  await settleAgentSessionChecks(ctx);expect(agentChecksPending(ctx,task.id)).toBe(false);
  expect(readTask(ctx,task.id)?.result).toMatchObject({executor:'codex',report:'Original output',acceptance:{passed:true}});
  expect(readFileSync(join(a.cwd,'checks-count'),'utf8').trim().split('\n')).toHaveLength(1);
  await settleAgentSessionChecks(ctx);expect(readFileSync(join(a.cwd,'checks-count'),'utf8').trim().split('\n')).toHaveLength(1);
 }finally{
  for(const s of [a,b]){const current=getAgentSession(ctx,task.id,s.id);if(current.live)await changeAgentSession(ctx,{task_id:task.id,id:s.id,expect_rev:current.rev},'end',deps);}
 }
},15000);

test('native adapter launch isolates Claude identities and hook directories and resumes only the original account',async()=>{
 const repo=gitRepo();
 const ctx=withLoginIndicators(fakeCtx({run:async(argv,timeout,options)=>argv[0]==='claude'
  ? {code:0,stdout:argv[1]==='--version'?'2.1.281':'--session-id --resume --add-dir --model --settings',stderr:''}
  :realRun(argv,timeout,options)}));
 ctx.env.PACER_LOGIN_ENV='off';ctx.env.PACER_REPORT_TOKEN='parent-token';ctx.env.PACER_WORK_GRANT='parent-grant';
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: codex\nproviders:\n  claude-code: {usage: reactive, max_tasks: 4}\n');
 const task=createTask(ctx,{brief:{goal:'Review',repo},kind:null,requestedExecutor:'claude-code',timeoutS:3600});
 updateTask(ctx,task.id,t=>{t.backend='direct';t.worktree=repo;t.placement={requested:'current',mode:'current'};});
 const specs:RunSpec[]=[],deps={start:(s:RunSpec)=>{specs.push(s);return {pid:12345};}};
 const input={task_id:task.id,request_id:'native-a',request:'Review code',executor:'claude-code'};
 const a=await createAgentSession(ctx,input,deps),b=await createAgentSession(ctx,{...input,request_id:'native-b'},deps);
 expect(a.state).not.toBe('failed');expect(b.state).not.toBe('failed');
 expect(a.nativeId).toBeTruthy();expect(b.nativeId).toBeTruthy();expect(a.nativeId).not.toBe(b.nativeId);
 expect(specs[0]!.argv).toContain(a.nativeId!);expect(specs[1]!.argv).toContain(b.nativeId!);
 expect(specs[0]!.env.PACER_REPORT_TOKEN).toBeUndefined();expect(specs[0]!.env.PACER_WORK_GRANT).toBeUndefined();
 expect(specs[0]!.env.PACER_TASK_ID).toBeUndefined();expect(specs[0]!.env.HOME).toBe(ctx.home);
 const resumed=await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'resume',deps);
 expect(resumed.nativeId).toBe(a.nativeId);expect(specs.at(-1)!.argv).toContain('--resume');
 expect(specs[0]!.dir).not.toBe(specs.at(-1)!.dir);
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: codex\nproviders:\n  claude-code: {usage: reactive, model: changed-model}\n');
 const sameAccount=await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:resumed.rev},'resume',deps);
 expect(sameAccount.nativeId).toBe(a.nativeId);expect(specs.at(-1)!.argv).not.toContain('changed-model');
 expect(specs).toHaveLength(4);
},15000);

import { taskDatabase } from '../src/tasks/store';
test('unreadable reservation records fail closed instead of releasing checkout ownership',async()=>{
 const {ctx,input,deps}=fixture();await createAgentSession(ctx,input,deps);
 taskDatabase(ctx).query('UPDATE agent_sessions SET record=?').run('{broken');
 expect(()=>activeAgentSessions(ctx)).toThrow('Session reservations could not be read');
});


test('a parent change during verification advances the generation instead of reusing a stale pass',async()=>{
 const {ctx,task,input,deps}=fixture();ctx.run=realRun;
 updateTask(ctx,task.id,t=>{t.state='done';t.brief.acceptance='echo started > started-check; sleep 0.3; echo checked >> check-runs';t.result={status:'done',executor:'codex',model:null,report:'Keep output',backend:'direct',files:''};});
 await createAgentSession(ctx,input,deps);
 const checking=settleAgentSessionChecks(ctx);
 await until(()=>{try{return readFileSync(join(task.brief.repo,'started-check'),'utf8').includes('started');}catch{return false;}});
 updateTask(ctx,task.id,t=>{t.brief.context='Parent changed while checks ran';});
 await checking;expect(agentChecksPending(ctx,task.id)).toBe(true);expect(readTask(ctx,task.id)?.result?.acceptance).toBeUndefined();
 await settleAgentSessionChecks(ctx);expect(agentChecksPending(ctx,task.id)).toBe(false);
 expect(readFileSync(join(task.brief.repo,'check-runs'),'utf8').trim().split('\n')).toHaveLength(2);
 expect(readTask(ctx,task.id)?.result?.acceptance?.passed).toBe(true);
},10000);

test('unplaced tasks cannot bind an agent to their source checkout',async()=>{
 const {ctx,task,input,deps}=fixture();
 for(const state of ['queued','running','done'] as const){
  updateTask(ctx,task.id,t=>{t.state=state;delete t.worktree;delete t.placement;});
  await expect(createAgentSession(ctx,{...input,request_id:`unplaced-${state}`},deps)).rejects.toMatchObject({code:'conflict'});
 }
 expect(listAgentSessions(ctx,task.id)).toHaveLength(0);
});
test('live needs_input primary owns overlapping checkout on create and restart',async()=>{
 const {ctx,task,input,deps}=fixture();
 const s=await createAgentSession(ctx,input,deps);
 const other=createTask(ctx,{brief:{goal:'Waiting primary',repo:task.brief.repo},kind:null,requestedExecutor:'codex',timeoutS:3600});
 const child=join(task.brief.repo,'nested');mkdirSync(child);
 updateTask(ctx,other.id,t=>{t.state='needs_input';t.worktree=child;t.live={backend:'direct',worker:'fixture',terminal:'fixture',executor:'codex',agent:'codex',since:ctx.now};});
 await expect(createAgentSession(ctx,{...input,request_id:'blocked-waiting'},deps)).rejects.toMatchObject({code:'conflict'});
 await expect(changeAgentSession(ctx,{task_id:task.id,id:s.id,expect_rev:s.rev},'retry',deps)).rejects.toMatchObject({code:'conflict'});
});

import { delegate } from '../src/tasks/api';
import { retry as retryLegacy } from '../src/core/tasks';
import { loadStrategy, validateStrategy } from '../src/config/strategy';
const correctionStrategy=validateStrategy({planner:'claude-code',providers:{'claude-code':{},codex:{session:'headless'}}},'fixture');
import { runAttempt } from '../src/exec/direct';
import { createConversation } from '../src/session/create';
import { agentSessionsRevision } from '../src/session/agents-state';

for(const placement of ['current','isolated'] as const)test(`${placement} retained checkout cannot transfer to another task while an added agent is live`,async()=>{
 const {ctx,task,input,deps}=liveFixture();
 const isolated=placement==='isolated'?join(ctx.home,'isolated'):task.brief.repo;
 if(placement==='isolated')expect((await realRun(['git','-C',task.brief.repo,'worktree','add','-b','retained',isolated],5000)).code).toBe(0);
 updateTask(ctx,task.id,t=>{t.state='done';t.worktree=isolated;t.placement={requested:'new',mode:'new'};});
 const a=await createAgentSession(ctx,input,deps);
 try {
  await until(()=>getAgentSession(ctx,task.id,a.id).live);
  expect(()=>delegate(ctx,{brief:{goal:'Legacy retry',repo:task.brief.repo},reuseWorktree:isolated},()=>undefined,correctionStrategy)).toThrow('Another task owns');
  await expect(retryLegacy(ctx,task.id,{}, {delegate:(c,i)=>delegate(c,i,()=>undefined,correctionStrategy)})).rejects.toMatchObject({code:'conflict'});
  expect(listTasks(ctx,100)).toHaveLength(1);
  const other=createTask(ctx,{brief:{goal:'Already recorded retry',repo:task.brief.repo},kind:null,requestedExecutor:'codex',timeoutS:3600});
  updateTask(ctx,other.id,t=>{t.worktree=isolated;t.placement={requested:'new',mode:'new'};});
  const out=await runAttempt(ctx,correctionStrategy.providers.codex!,readTask(ctx,other.id)!);
  expect(out.exec.code).toBe(1);expect(out.report).toContain('another pacer task');
 }finally{await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);}
},10000);

test('concurrent conversation admission waits on the same checkout reservation lock',async()=>{
 const {ctx,task,input,deps}=liveFixture();updateTask(ctx,task.id,t=>{t.state='done';});
 mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  codex: {usage: reactive}\n');
 let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const pending=createAgentSession(ctx,input,{...deps,launch:async(...args)=>{entered();await gate;return deps.launch(args[0],args[1]);}});
 await ready;
 let completed=false,spawns=0;
 const other=createConversation(ctx,{request_id:'concurrent',draftId:'draft',request:'Different task',repo:task.brief.repo,executor:'codex',workspace:{mode:'current',path:task.brief.repo},attachments:[]},{prepare:async()=>({repo:{path:task.brief.repo},executors:[{id:'codex',available:true}],checkouts:[{path:task.brief.repo}]}) as any,spawnRunner:()=>{spawns++;return undefined;}}).then(()=>{completed=true;return null;},e=>{completed=true;return e;});
 await Bun.sleep(100);expect(completed).toBe(false);release();
 const a=await pending;
 try{expect(await other).toMatchObject({code:'conflict'});expect(spawns).toBe(0);expect(listTasks(ctx,100)).toHaveLength(1);}finally{await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);}
},10000);

test('service lifecycle revision observes cross-client creation and unexpected process exit without reads from a panel',async()=>{
 const {ctx,task,input,deps}=liveFixture();
 const before=agentSessionsRevision(ctx),a=await createAgentSession(ctx,input,{...deps,launch:async(_ctx,s)=>({argv:['/bin/sh','-c','sleep 0.5'],cwd:s.cwd,env:{...process.env,HOME:ctx.home,PACER_HOME:ctx.pacerHome,PACER_LOGIN_ENV:'off'}})});
 const started=agentSessionsRevision({...ctx});expect(started).not.toBe(before);
 try{await until(()=>!getAgentSession(ctx,task.id,a.id).live);expect(agentSessionsRevision({...ctx})).not.toBe(started);}finally{await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);}
},10000);

import { pumpOnce } from '../src/link/pump';
import { publish } from '../src/link/publish';
import { eventsSince } from '../src/api/events';
import { initialState, reduceStore } from '../app/src/data/store';
import { queryRevision } from '../app/src/screens/task-shared';

test('first service pump publishes agent lifecycle through durable events into client query invalidation',async()=>{
 const {ctx,task,input,deps}=fixture();
 let client={...initialState(),needsSnapshot:false,connected:true,snapshot:{seq:0,tasks:[],at:0} as any};
 const before=queryRevision(client,'session.agent.list',{});
 const a=await createAgentSession(ctx,input,deps);
 const pumpDeps={status:async()=>({generatedAt:ctx.now,strategy:'fixture',planner:'codex',mode:'normal',disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}}) as any,tasks:()=>[],publish};
 const returned=await pumpOnce(ctx,pumpDeps);
 expect(returned.some(e=>e.type==='config'&&(e.data as any).area==='agent-sessions')).toBe(true);
 const batch=eventsSince(ctx,0);
 const changed=batch.events.find(e=>e.type==='config'&&(e.data as any).area==='agent-sessions');
 expect(changed).toBeDefined();
 client=reduceStore(client,{type:'event',event:changed!});
 expect(queryRevision(client,'session.agent.list',{})).not.toBe(before);
 const seq=batch.last;
 await pumpOnce(ctx,pumpDeps);expect(eventsSince(ctx,seq).events.some(e=>e.type==='config'&&(e.data as any).area==='agent-sessions')).toBe(false);
 await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);
 await pumpOnce(ctx,pumpDeps);expect(eventsSince(ctx,seq).events.some(e=>e.type==='config'&&(e.data as any).area==='agent-sessions')).toBe(true);
});

test('workspace binding rejects unrelated repository replacement on creation and restart',async()=>{
 const {ctx,task,input,deps}=fixture(),a=await createAgentSession(ctx,input,deps);
 updateTask(ctx,task.id,t=>{t.worktree=gitRepo();});
 await expect(createAgentSession(ctx,{...input,request_id:'replaced'},deps)).rejects.toMatchObject({code:'conflict'});
 await expect(changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'retry',deps)).rejects.toMatchObject({code:'conflict'});
});

import { startRun } from '../src/supervisor/run';
import { withLock } from '../src/core/lock';

test('concurrent native admissions share the configured slot cap with a live PTY reservation',async()=>{
 const repo=gitRepo(),ctx=withLoginIndicators(fakeCtx({run:async(argv,timeout,options)=>argv[0]==='claude'?{code:0,stdout:argv[1]==='--version'?'2.1.281':'--session-id --resume --add-dir --model --settings',stderr:''}:realRun(argv,timeout,options)}));
 ctx.env.PACER_LOGIN_ENV='off';mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: codex\nproviders:\n  claude-code: {usage: reactive, max_tasks: 1}\n');
 const task=createTask(ctx,{brief:{goal:'Slot test',repo},kind:null,requestedExecutor:'claude-code',timeoutS:3600});
 updateTask(ctx,task.id,t=>{t.state='done';t.worktree=repo;t.backend='direct';});
 const deps={start:(spec:RunSpec)=>startRun({...spec,argv:['/bin/sh','-c','sleep 30']})};
 const results=await Promise.allSettled(['one','two'].map(request_id=>createAgentSession(ctx,{task_id:task.id,executor:'claude-code',request_id,request:'Inspect'},deps)));
 try{
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'conflict'}});
  expect(slotUse([],ctx).local).toBe(1);expect(listTasks(ctx,100)).toHaveLength(1);
 }finally{for(const s of listAgentSessions(ctx,task.id))if(s.live)await changeAgentSession(ctx,{task_id:task.id,id:s.id,expect_rev:s.rev},'end');}
},10000);

test('synchronous legacy admission returns conflict immediately while asynchronous admission owns shared lock',async()=>{
 const {ctx,task}=fixture();
 await withLock(ctx,'session-create',async()=>{
  expect(()=>delegate(ctx,{brief:{goal:'Retry',repo:task.brief.repo}},()=>undefined,correctionStrategy)).toThrow('Workspace admission is busy');
  try{delegate(ctx,{brief:{goal:'Retry',repo:task.brief.repo}},()=>undefined,correctionStrategy);}catch(e){expect(e).toMatchObject({code:'conflict'});}
 });
 expect(listTasks(ctx,100)).toHaveLength(1);
});

import { requireAgentWorkspaceBackend } from '../src/session/agents-state';
test('pending final checks reserve overlapping checkouts through acceptance and release after publication',async()=>{
 const {ctx,task,input,deps}=fixture();
 updateTask(ctx,task.id,t=>{t.state='done';t.brief.acceptance='echo started > ownership-check; sleep 0.4';});
 const other=createTask(ctx,{brief:{goal:'Other settled task',repo:task.brief.repo},kind:null,requestedExecutor:'codex',timeoutS:60});
 updateTask(ctx,other.id,t=>{t.state='done';t.backend='direct';t.worktree=task.brief.repo;});
 const prior=await createAgentSession(ctx,{...input,task_id:other.id,request_id:'other-prior'},deps);
 await settleAgentSessionChecks(ctx);
 await createAgentSession(ctx,input,deps);
 expect(agentWorkspaceBusy(ctx,task.brief.repo,other.id)).toBe(true);
 const checking=settleAgentSessionChecks(ctx);
 try {
  await until(()=>{try{return readFileSync(join(task.brief.repo,'ownership-check'),'utf8').includes('started');}catch{return false;}});
  await expect(createAgentSession(ctx,{...input,task_id:other.id,request_id:'during-check'},deps)).rejects.toMatchObject({code:'conflict'});
  for(const action of ['retry','resume'] as const)await expect(changeAgentSession(ctx,{task_id:other.id,id:prior.id,expect_rev:prior.rev},action,deps)).rejects.toMatchObject({code:'conflict'});
  expect(()=>delegate(ctx,{brief:{goal:'Primary reuse',repo:task.brief.repo},reuseWorktree:task.brief.repo},()=>undefined,correctionStrategy)).toThrow('Another task owns');
  const result=await runAttempt(ctx,correctionStrategy.providers.codex!,readTask(ctx,other.id)!);
  expect(result.report).toContain('another pacer task');
 }finally{await checking;}
 expect(agentWorkspaceBusy(ctx,task.brief.repo,other.id)).toBe(false);
},10000);
test('final-check ownership stays on its admitted checkout after parent metadata changes and stop waits for capture',async()=>{
 const {ctx,task,input,deps}=fixture();
 updateTask(ctx,task.id,t=>{t.state='done';});
 await createAgentSession(ctx,input,deps);
 updateTask(ctx,task.id,t=>{t.worktree=gitRepo();});
 expect(agentWorkspaceBusy(ctx,task.brief.repo,'another-task')).toBe(true);
 let stopping!:Promise<void>,stopped=false;
 await withLock(ctx,`clean-${task.id}`,async()=>{
  stopping=stopAgentSessionChecks(ctx,task.id).then(()=>{stopped=true;});
  await Bun.sleep(60);
  expect(stopped).toBe(false);expect(agentWorkspaceBusy(ctx,task.brief.repo,'another-task')).toBe(true);
 });
 await stopping;
 expect(agentWorkspaceBusy(ctx,task.brief.repo,'another-task')).toBe(false);
});
test('live same-task sessions prevent primary fallback to Orca or remote and unknown initial hosts are refused',async()=>{
 const {ctx,task,input,deps}=liveFixture(),a=await createAgentSession(ctx,input,deps);
 try{
  await withLock(ctx,'session-create',async()=>{
   expect(()=>requireAgentWorkspaceBackend(ctx,task.id,'orca',false)).toThrow('End additional agent sessions');
   expect(()=>requireAgentWorkspaceBackend(ctx,task.id,'direct',true)).toThrow('End additional agent sessions');
   expect(()=>requireAgentWorkspaceBackend(ctx,task.id,'direct',false)).not.toThrow();
  });
 }finally{await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);}
 for(const backend of ['orca',undefined]){
  updateTask(ctx,task.id,t=>{t.backend=backend;});
  await expect(createAgentSession(ctx,{...input,request_id:`host-${backend}`},deps)).rejects.toMatchObject({code:backend==='orca'?'not_allowed':'conflict'});
 }
 updateTask(ctx,task.id,t=>{t.backend='direct';t.executor='codex@remote';});
 await expect(createAgentSession(ctx,{...input,request_id:'remote-host'},deps)).rejects.toMatchObject({code:'not_allowed'});
},10000);

test('unexpected PTY exit publishes durable cross-client invalidation with all agent panels closed',async()=>{
 const {ctx,task,input,deps}=liveFixture();
 const pumpDeps={status:async()=>({generatedAt:ctx.now,strategy:'fixture',planner:'codex',mode:'normal',disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}}) as any,tasks:()=>[],publish};
 await pumpOnce(ctx,pumpDeps);
 const a=await createAgentSession(ctx,input,{...deps,launch:async(_ctx,s)=>({argv:['/bin/sh','-c','sleep 0.5'],cwd:s.cwd,env:{...process.env,HOME:ctx.home,PACER_HOME:ctx.pacerHome,PACER_LOGIN_ENV:'off'}})});
 try{
  await pumpOnce(ctx,pumpDeps);const cursor=eventsSince(ctx,0).last;
  await until(()=>!readRun(agentSessionDirectory(ctx,task.id,a.id)).alive);
  await pumpOnce({...ctx},pumpDeps);
  expect(eventsSince(ctx,cursor).events).toContainEqual(expect.objectContaining({type:'config',data:expect.objectContaining({area:'agent-sessions'})}));
 }finally{await changeAgentSession(ctx,{task_id:task.id,id:a.id,expect_rev:a.rev},'end',deps);}
},10000);

test('lifecycle watch keeps uncertain starts observable until explicit exit evidence',async()=>{
 const {ctx,input,deps,specs}=fixture();
 const a=await createAgentSession(ctx,input,{...deps,launch:async(_ctx,s)=>({argv:['/bin/sh','-c','sleep 0.8'],cwd:s.cwd,env:{...process.env,HOME:ctx.home,PACER_HOME:ctx.pacerHome,PACER_LOGIN_ENV:'off'}})});
 const uncertain=agentSessionsRevision(ctx);
 // The reservation is already stored, but the host has not yet published its pid.
 const result=startRun(specs[0]!);expect('pid' in result).toBe(true);
 const live=agentSessionsRevision({...ctx});expect(live).not.toBe(uncertain);
 await until(()=>readRun(specs[0]!.dir).exit!==null);
 const ended=agentSessionsRevision({...ctx});expect(ended).not.toBe(live);
 expect(agentSessionsRevision({...ctx})).toBe(ended);
});

test('retained session history has stable cached revisions and cross-context mutation invalidation',async()=>{
 const {ctx,input,deps}=fixture(),a=await createAgentSession(ctx,input,deps),db=taskDatabase(ctx);
 const template=db.query<{record:string},[string]>('SELECT record FROM agent_sessions WHERE id=?').get(a.id)!;
 db.transaction(()=>{for(let i=0;i<3000;i++){
  const id=`retained-${i}`,record={...JSON.parse(template.record),id,state:'ended'};
  db.query('INSERT INTO agent_sessions(id,task,request_id,payload,record) VALUES(?,?,?,?,?)').run(id,a.task_id,id,'{}',JSON.stringify(record));
 }}).immediate();
 const revision=agentSessionsRevision(ctx),started=performance.now();
 for(let i=0;i<20;i++)expect(agentSessionsRevision({...ctx})).toBe(revision);
 console.log(`retained-history: 3000 ended records, 20 warmed revisions in ${(performance.now()-started).toFixed(1)}ms`);
 const changed={...JSON.parse(template.record),id:'retained-2999',state:'ended',rev:42};
 db.query('UPDATE agent_sessions SET record=? WHERE id=?').run(JSON.stringify(changed),changed.id);
 expect(agentSessionsRevision({...ctx})).not.toBe(revision);
});
