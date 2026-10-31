import { apiTask } from '../api/read-model/tasks';
import type { ApiTask } from '../api/read-model/types';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../core/errors';
import { withLock } from '../core/lock';
import { isExecutorSession } from '../install/role';
import { readTask, listTasksWhere, taskDatabase } from '../tasks/store';
import { readRun, startRun, stopRun, type RunSpec } from '../supervisor/run';
import { withWork } from '../update/desktop/admission';
import { conversationActivity } from './conversation';
import { loadStrategy } from '../config/strategy';
import { SLOT_STATES, slotUse, slotBlock } from '../engine/slots';
import { invalidateAgentChecks } from './agents-checks';
import { activeAgentSessions, workspaceBusy, taskAgentWorkspace } from './agents-state';
import { launchAgentSession } from './agents-launch';
import { prepareAgentAdmission } from './agents-admission';
import type { Ctx } from '../types';

interface Attempt { number:number; nativeId?:string; state:'starting'|'running'|'ended'|'failed'; error?:string }
export interface StoredAgentSession {
 id:string; task_id:string; ordinal:number; executor:string; request:string; cwd:string; createdAt:number;
 rev:number; attempt:number; nativeId?:string; accountKey?:string; model?:string|null;
 state:Attempt['state']; error?:string; attempts:Attempt[];
}
export interface AgentSession extends StoredAgentSession {
 ownerTask:ApiTask; live:boolean; activity:string; cols:number; rows:number; controller:string|null;
 attach:{ws:string};
}
export interface AgentSessionInput { task_id:string; request_id:string; executor:string; request:string }
export interface AgentSessionChange { task_id:string; id:string; expect_rev:number }
export interface AgentLaunch { argv:string[]; cwd:string; env:Record<string,string|undefined>; stdin?:string; identity?:string; accountKey?:string; model?:string|null; umask?:string; keepColor?:string[] }
export interface AgentSessionDeps {
 launch?:(ctx:Ctx,session:StoredAgentSession,dir:string,resume:boolean)=>Promise<AgentLaunch>;
 start?:typeof startRun;
 stop?:typeof stopRun;
}
function human(ctx:Ctx) {
 if(isExecutorSession(ctx)) throw new CoreError('not_allowed','Executor sessions cannot manage interactive agents');
}
function database(ctx:Ctx) {
 const db=taskDatabase(ctx);
 db.run('CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, task TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, record TEXT NOT NULL)');
 // A durable mutation generation avoids rereading retained history on every pump.
 db.run('CREATE TABLE IF NOT EXISTS agent_session_revision(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL)');
 db.run('INSERT OR IGNORE INTO agent_session_revision VALUES(1,0)');
 for(const action of ['INSERT','UPDATE','DELETE'])db.run(`CREATE TRIGGER IF NOT EXISTS agent_session_revision_${action.toLowerCase()} AFTER ${action} ON agent_sessions BEGIN UPDATE agent_session_revision SET generation=generation+1 WHERE id=1; END`);
 return db;
}
function owner(ctx:Ctx,id:string) {
 const task=readTask(ctx,id);
 if(!task)throw new CoreError('unknown_task',`unknown task ${id}`);
 return task;
}
function stored(ctx:Ctx,task:string,id:string):StoredAgentSession {
 owner(ctx,task);
 const row=database(ctx).query<{record:string},[string,string]>('SELECT record FROM agent_sessions WHERE id=? AND task=?').get(id,task);
 if(!row)throw new CoreError('invalid_input','Agent session does not belong to this task');
 return JSON.parse(row.record);
}
function save(ctx:Ctx,session:StoredAgentSession) {
 database(ctx).query('UPDATE agent_sessions SET record=? WHERE id=? AND task=?').run(JSON.stringify(session),session.id,session.task_id);
}
function runDirectory(ctx:Ctx,s:StoredAgentSession,attempt=s.attempt) {
 return join(ctx.pacerHome,'agent-sessions',s.id,String(attempt));
}
export function agentSessionDirectory(ctx:Ctx,task:string,id:string,attempt?:number):string {
 const s=stored(ctx,task,id),n=attempt??s.attempt;
 if(!Number.isSafeInteger(n)||n<1||n>s.attempt)throw new CoreError('invalid_input','Unknown session attempt');
 return runDirectory(ctx,s,n);
}
function view(ctx:Ctx,s:StoredAgentSession,ownerTask?:ApiTask):AgentSession {
 const dir=runDirectory(ctx,s),run=readRun(dir);
 let state:{cols?:number;rows?:number;controller?:string}={};
 try{state=JSON.parse(readFileSync(join(dir,'session.state'),'utf8'));}catch{/* host has not published geometry */}
 let nativeId=s.nativeId;
 try{const id=readFileSync(join(dir,'agent-session-id'),'utf8').trim();if(/^[A-Za-z0-9_-]{1,128}$/.test(id))nativeId=id;}catch{/* agent has not reported identity */}
 const live=run.alive;
 // A service crash during preparation is never silently relaunched. A retry gets a new attempt.
 const status=s.state==='running'&&!live?'ended':s.state;
 return {...s,ownerTask:ownerTask??apiTask(ctx,owner(ctx,s.task_id)),nativeId,state:status,live,activity:live?conversationActivity(run):'ended',cols:state.cols??120,rows:state.rows??40,controller:live?state.controller??null:null,
  attach:{ws:`/v3/tasks/${s.task_id}/agent-sessions/${s.id}/session?attempt=${s.attempt}`}};
}
export function getAgentSession(ctx:Ctx,task:string,id:string):AgentSession {human(ctx);return view(ctx,stored(ctx,task,id));}
export function listAgentSessions(ctx:Ctx,task?:string):AgentSession[] {
 human(ctx);if(task)owner(ctx,task);
 const rows=task?database(ctx).query<{record:string},[string]>('SELECT record FROM agent_sessions WHERE task=? ORDER BY rowid').all(task):database(ctx).query<{record:string},[]>('SELECT record FROM agent_sessions ORDER BY rowid DESC LIMIT 1000').all();
 const active=activeAgentSessions(ctx),counts=new Map<string,number>();
 for(const s of active)counts.set(s.task_id,(counts.get(s.task_id)??0)+1);
 const sessions=new Map(rows.map(row=>{const s=JSON.parse(row.record) as StoredAgentSession;return [s.id,s] as const;}));
 for(const s of active)if(!task||s.task_id===task)sessions.set(s.id,s);
 const owners=new Map<string,ApiTask>();
 return [...sessions.values()].map(s=>{
  if(!owners.has(s.task_id))owners.set(s.task_id,apiTask(ctx,owner(ctx,s.task_id),undefined,undefined,counts.get(s.task_id)??0));
  return view(ctx,s,owners.get(s.task_id));
 });
}
function launch(ctx:Ctx,s:StoredAgentSession,prepared:AgentLaunch,deps:AgentSessionDeps) {
 const dir=runDirectory(ctx,s);
 mkdirSync(dir,{recursive:true,mode:0o700});
 try {
  if(!deps.launch){const reason=slotBlock(loadStrategy(ctx),s.executor,slotUse(listTasksWhere(ctx,{states:SLOT_STATES}),ctx,s.id),{guard:true});if(reason)throw new CoreError('conflict',reason);}
  s.nativeId=prepared.identity;s.accountKey=prepared.accountKey;s.model=prepared.model;
  // Persist identity before spawn: an ambiguous start must never reuse an attempt directory.
  s.attempts[s.attempt-1]={number:s.attempt,state:'starting',nativeId:s.nativeId};save(ctx,s);
  const result=(deps.start??startRun)({...prepared,dir,session:'interactive',interactionMode:'conversation'});
  if('error' in result)throw new Error(result.error);
  s.state='running';delete s.error;
  s.attempts[s.attempt-1]={number:s.attempt,state:s.state,nativeId:s.nativeId};save(ctx,s);return view(ctx,s);
 }catch(error){s.state='failed';s.error=error instanceof CoreError?error.message:'Could not launch agent session. Check the selected account and agent installation.';
  s.attempts[s.attempt-1]={number:s.attempt,state:'failed',nativeId:s.nativeId,error:s.error};save(ctx,s);
  if(error instanceof CoreError&&error.code==='conflict')throw error;
 }
 s.attempts[s.attempt-1]={number:s.attempt,state:s.state,nativeId:s.nativeId,...(s.error?{error:s.error}:{})};
 save(ctx,s);return view(ctx,s);
}
export async function createAgentSession(ctx:Ctx,input:AgentSessionInput,deps:AgentSessionDeps={}):Promise<AgentSession> {
 human(ctx);
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(input.request_id)||!input.request.trim()||input.request.length>200000)throw new CoreError('invalid_input','A request and request ID are required');
 const payload=createHash('sha256').update(JSON.stringify([input.task_id,input.executor,input.request])).digest('hex');
  return withWork(ctx,{kind:'operation',id:input.request_id,label:'Starting task agent session'},()=>withLock(ctx,'agent-admission',async()=>{
   const task=owner(ctx,input.task_id),db=database(ctx);
  const previous=db.query<{payload:string;record:string},[string]>('SELECT payload,record FROM agent_sessions WHERE request_id=?').get(input.request_id);
  if(previous){if(previous.payload!==payload)throw new CoreError('conflict','Session request ID was used with different details');return view(ctx,JSON.parse(previous.record));}
   const cwd=await taskAgentWorkspace(ctx,task);
   const ordinal=db.query<{n:number},[string]>('SELECT count(*) AS n FROM agent_sessions WHERE task=?').get(task.id)!.n+1;
   const s:StoredAgentSession={id:randomUUID(),task_id:task.id,ordinal,executor:input.executor,request:input.request,cwd,createdAt:ctx.now,rev:1,attempt:1,state:'starting',attempts:[{number:1,state:'starting'}]};
   const admission=await prepareAgentAdmission(ctx,s);
   return withLock(ctx,`clean-${input.task_id}`,()=>withLock(ctx,'agent-sessions',()=>withLock(ctx,'session-create',async()=>{
    admission.revalidate();
    if(task.state==='running'&&task.progress?.phase==='testing')throw new CoreError('conflict','Task checks are running; wait before starting another session');
    if(workspaceBusy(ctx,cwd,task.id))throw new CoreError('conflict','Another task owns this checkout');
    if(activeAgentSessions(ctx).length>=16)throw new CoreError('not_allowed','Too many active agent sessions; end one before starting another');
    mkdirSync(runDirectory(ctx,s),{recursive:true,mode:0o700});
    const prepared=await (deps.launch??launchAgentSession)(ctx,s,runDirectory(ctx,s),false);
    return withLock(ctx,'slots',()=>admission.consume(()=>{
     const current=owner(ctx,task.id);
     if(current.state==='running'&&current.progress?.phase==='testing')throw new CoreError('conflict','Task checks are running; wait before starting another session');
     if(workspaceBusy(ctx,cwd,task.id))throw new CoreError('conflict','Another task owns this checkout');
     if(activeAgentSessions(ctx).length>=16)throw new CoreError('not_allowed','Too many active agent sessions; end one before starting another');
     if(!deps.launch){const reason=slotBlock(loadStrategy(ctx),s.executor,slotUse(listTasksWhere(ctx,{states:SLOT_STATES}),ctx),{guard:true});if(reason)throw new CoreError('conflict',reason);}
     invalidateAgentChecks(ctx,task.id);
     db.query('INSERT INTO agent_sessions(id,task,request_id,payload,record) VALUES(?,?,?,?,?)').run(s.id,s.task_id,input.request_id,payload,JSON.stringify(s));
     return launch(ctx,s,prepared,deps);
    }));
   },{staleMs:600000}),{staleMs:600000}));
  },{staleMs:600000}));
}
export async function changeAgentSession(ctx:Ctx,input:AgentSessionChange,action:'end'|'retry'|'resume',deps:AgentSessionDeps={}):Promise<AgentSession> {
 human(ctx);
  return withWork(ctx,{kind:'operation',id:input.id,label:`Updating agent session`},()=>withLock(ctx,'agent-admission',async()=>{
   const initial=stored(ctx,input.task_id,input.id),initialView=view(ctx,initial);
   if(initial.rev!==input.expect_rev)throw new CoreError('conflict','Session changed; refresh and try again');
   const next=structuredClone(initial);
   next.nativeId=action==='resume'?initialView.nativeId:undefined;next.attempt++;
   const admission=action==='end'?undefined:await prepareAgentAdmission(ctx,next);
   return withLock(ctx,`clean-${input.task_id}`,()=>withLock(ctx,'agent-sessions',()=>withLock(ctx,'session-create',async()=>{
  const s=stored(ctx,input.task_id,input.id),current=view(ctx,s),dir=runDirectory(ctx,s);
  if(s.rev!==input.expect_rev)throw new CoreError('conflict','Session changed; refresh and try again');
  if(action==='end'){
   await (deps.stop??stopRun)(dir,{graceMs:2000});s.state='ended';s.nativeId=current.nativeId;s.rev++;
   s.attempts[s.attempt-1]={number:s.attempt,state:'ended',nativeId:s.nativeId};save(ctx,s);return view(ctx,s);
  }
  const task=owner(ctx,s.task_id);
  if(task.state==='running'&&task.progress?.phase==='testing')throw new CoreError('conflict','Task checks are running; wait before restarting a session');
  if(await taskAgentWorkspace(ctx,task)!==s.cwd)throw new CoreError('conflict','The task workspace changed; restore it before restarting this session');
  if(workspaceBusy(ctx,s.cwd,s.task_id))throw new CoreError('conflict','Another task owns this checkout');
  if(readRun(dir).alive)throw new CoreError('conflict','Session is still running; end it before restarting');
  if(action==='resume'&&!current.nativeId)throw new CoreError('not_allowed','The agent did not report a resumable session identity');
  if(activeAgentSessions(ctx).length>=16)throw new CoreError('not_allowed','Too many active agent sessions');
   admission!.revalidate();
   mkdirSync(runDirectory(ctx,next),{recursive:true,mode:0o700});
   const prepared=await (deps.launch??launchAgentSession)(ctx,next,runDirectory(ctx,next),action==='resume');
   return withLock(ctx,'slots',()=>admission!.consume(()=>{
    if(stored(ctx,input.task_id,input.id).rev!==input.expect_rev)throw new CoreError('conflict','Session changed; refresh and try again');
    if(workspaceBusy(ctx,s.cwd,s.task_id))throw new CoreError('conflict','Another task owns this checkout');
    if(!deps.launch){const reason=slotBlock(loadStrategy(ctx),s.executor,slotUse(listTasksWhere(ctx,{states:SLOT_STATES}),ctx,s.id),{guard:true});if(reason)throw new CoreError('conflict',reason);}
    s.attempts[s.attempt-1]={number:s.attempt,state:current.state==='failed'?'failed':'ended',nativeId:current.nativeId};
    invalidateAgentChecks(ctx,s.task_id);
    s.nativeId=next.nativeId;s.attempt++;s.rev++;s.state='starting';delete s.error;
    s.attempts.push({number:s.attempt,state:'starting'});save(ctx,s);
    return launch(ctx,s,prepared,deps);
   }));
  },{staleMs:600000}),{staleMs:600000}));
  },{staleMs:600000}));
}

/** Task-wide stop retains every conversation and attempt. Also used for an ended parent. */
export async function stopTaskAgentSessions(ctx:Ctx,task:string):Promise<void> {
 await withLock(ctx,'agent-sessions',async()=>{
  for(const session of activeAgentSessions(ctx).filter(s=>s.task_id===task)) {
   const current=view(ctx,session);
   await stopRun(runDirectory(ctx,session),{graceMs:2000});
   session.state='ended';session.nativeId=current.nativeId;session.rev++;
   session.attempts[session.attempt-1]={number:session.attempt,state:'ended',nativeId:session.nativeId};save(ctx,session);
  }
 },{staleMs:600000});
}
