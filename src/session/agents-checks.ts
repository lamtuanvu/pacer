import { existsSync, utimesSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../core/errors';
import { withLock } from '../core/lock';
import { openReadOnlyStore } from '../dispatch/readonly';
import { readTask, taskDatabase, updateTask } from '../tasks/store';
import { TERMINAL_STATES } from '../tasks/types';
import { persistTaskDiff } from '../tasks/diff';
import { verifyRepo } from '../exec/verify';
import { withWork } from '../update/desktop/admission';
import { startRun, readRun, readOutput, stopRun } from '../supervisor/run';
import type { ExecSpec, ExecResult } from '../exec/process';
import { activeAgentSessions, workspaceBusy, canonical } from './agents-state';
import type { Ctx } from '../types';

export interface AgentCheck {task:string;generation:number;verified:number;checking:number;workspace?:string;cancelled?:number}
function database(ctx:Ctx) {
 const db=taskDatabase(ctx);
 // Schema decisions use the same writer admission as cancellation and launch;
 // concurrent first-use processes must re-inspect after the preceding migration.
 db.transaction(()=>{
  db.run('CREATE TABLE IF NOT EXISTS agent_session_checks(task TEXT PRIMARY KEY,generation INTEGER NOT NULL,verified INTEGER NOT NULL,checking INTEGER NOT NULL DEFAULT 0)');
  if(!db.query<{name:string},[]>('PRAGMA table_info(agent_session_checks)').all().some(column=>column.name==='workspace'))db.run('ALTER TABLE agent_session_checks ADD COLUMN workspace TEXT');
  if(!db.query<{name:string},[]>('PRAGMA table_info(agent_session_checks)').all().some(column=>column.name==='cancelled'))db.run('ALTER TABLE agent_session_checks ADD COLUMN cancelled INTEGER NOT NULL DEFAULT 0');
 }).immediate();
 return db;
}
export function pendingAgentChecks(ctx:Ctx):AgentCheck[] {
 const db=openReadOnlyStore(ctx,true);
 try{return db.has('agent_session_checks')?db.query<AgentCheck>('SELECT * FROM agent_session_checks WHERE generation>verified'):[];}finally{db.close();}
}
export function agentChecksPending(ctx:Ctx,task:string):boolean {return pendingAgentChecks(ctx).some(c=>c.task===task);}
/** Caller owns the registry and task clean locks. Any new attempt invalidates older checks/review. */
export function invalidateAgentChecks(ctx:Ctx,task:string):void {
 const db=database(ctx);
 if(db.query<AgentCheck,[string]>('SELECT * FROM agent_session_checks WHERE task=?').get(task)?.checking)throw new CoreError('conflict','Task checks are still running; wait before starting another session');
 db.transaction(()=>{
  const owner=readTask(ctx,task)!;
  const workspace=canonical(owner.worktree??owner.run?.workdir??owner.brief.repo);
  db.query('INSERT INTO agent_session_checks(task,generation,verified,workspace) VALUES(?,1,0,?) ON CONFLICT(task) DO UPDATE SET generation=generation+1,workspace=excluded.workspace').run(task,workspace);
  updateTask(ctx,task,t=>{if(t.result)delete t.result.acceptance;delete t.review;delete t.reviewRequest;delete t.resolved;delete t.dismissed;});
 }).immediate();
}
/** Run acceptance in the existing durable supervisor so service reconnect never duplicates a check. */
async function durableAcceptance(ctx:Ctx,check:AgentCheck,spec:ExecSpec):Promise<ExecResult> {
  const parent=join(ctx.pacerHome,'agent-checks',check.task),dir=join(parent,String(check.generation));
  // Stop and launch share SQLite's cross-process writer admission. The final
  // generation/cancellation check and synchronous spawn cannot be split by an
  // await (or by another process recording a cancellation).
  const launch = database(ctx).transaction(() => {
    const current = database(ctx).query<AgentCheck,[string]>('SELECT * FROM agent_session_checks WHERE task=?').get(check.task);
    if (!current || current.generation !== check.generation || current.verified >= check.generation || (current.cancelled ?? 0) >= check.generation) return 'cancelled';
    mkdirSync(parent,{recursive:true,mode:0o700});
    if (!existsSync(dir)) {
      mkdirSync(dir,{mode:0o700});
      writeFileSync(join(dir,'check.json'),JSON.stringify({startedAt:Date.now()}),{mode:0o600,flag:'wx'});
      const env={...spec.env,HOME:ctx.home,PACER_HOME:ctx.pacerHome};
      if ('error' in startRun({dir,argv:spec.argv,cwd:spec.cwd,env,session:'pipe'})) return 'failed';
    }
    return 'started';
  }).immediate();
  if (launch !== 'started') return {code:127,stdout:'',stderr:launch === 'cancelled' ? 'Task checks were stopped' : 'Could not launch task checks',timedOut:false};
 let startedAt:number;
 try{startedAt=JSON.parse(readFileSync(join(dir,'check.json'),'utf8')).startedAt;}catch{return {code:127,stdout:'',stderr:'Task check launch was interrupted; start a fresh conversation to retry',timedOut:false};}
 const deadline=startedAt+spec.timeoutMs;
 while(readRun(dir).alive&&Date.now()<deadline)await Bun.sleep(100);
 const timedOut=readRun(dir).alive;
 if(timedOut)await stopRun(dir,{graceMs:2000});
 const result=readRun(dir),output=readOutput(dir);
 return {code:result.exit??127,...output,timedOut};
}

/** Parent verification starts only after every added session and the primary task settle. */
export async function settleAgentSessionChecks(ctx:Ctx):Promise<void> {
 for(const check of pendingAgentChecks(ctx)) {
  await withWork(ctx,{kind:'operation',id:`agent-check-${check.task}`,label:'Checking task after agent sessions'},()=>withLock(ctx,`clean-${check.task}`,async()=>{
   const task=readTask(ctx,check.task);
   if(!task||!TERMINAL_STATES.includes(task.state)||activeAgentSessions(ctx).some(s=>s.task_id===check.task))return;
   const workspace=check.workspace??canonical(task.worktree??task.run?.workdir??task.brief.repo);
   if(workspace!==canonical(task.worktree??task.run?.workdir??task.brief.repo))return;
   const claimed=await withLock(ctx,'agent-sessions',()=>withLock(ctx,'session-create',async()=>{
    const current=database(ctx).query<AgentCheck,[string]>('SELECT * FROM agent_session_checks WHERE task=?').get(check.task);
     if(!current||current.generation!==check.generation||current.verified>=current.generation||(current.cancelled??0)>=check.generation)return false;
    if(readTask(ctx,task.id)?.rev!==task.rev||workspaceBusy(ctx,workspace,task.id))return false;
    database(ctx).query('UPDATE agent_session_checks SET checking=1 WHERE task=?').run(check.task);return true;
   },{staleMs:600000}),{staleMs:600000});
   if(!claimed)return;
   // All clean-lock takers see a fresh mtime, including the legacy default stale window.
   const lock=join(ctx.pacerHome,'orca',`clean-${check.task}.lock`);
   const heartbeat=setInterval(()=>{try{if(existsSync(lock)){const now=new Date();utimesSync(lock,now,now);}}catch{/* CAS below still prevents stale publication */}},10000);
   try {
    if(task.state==='stopped') {
     database(ctx).query('UPDATE agent_session_checks SET verified=generation,checking=0 WHERE task=?').run(check.task);return;
    }
    const verification=await verifyRepo(workspace,task.brief.acceptance,ctx.env,(task.brief.acceptanceTimeoutMin??10)*60000,task.brief.pipefail,spec=>durableAcceptance(ctx,check,spec));
    await persistTaskDiff(ctx,{...task,worktree:workspace,...(task.run?{run:{...task.run,workdir:workspace}}:{})});
    await withLock(ctx,'agent-sessions',async()=>{
     database(ctx).transaction(()=>{
      const current=readTask(ctx,task.id),generation=database(ctx).query<AgentCheck,[string]>('SELECT * FROM agent_session_checks WHERE task=?').get(task.id);
      // A stopped generation must neither publish a pass/failure nor advance to
      // fresh work. Stop releases its reservation only after this clean scope.
      if(generation?.generation===check.generation&&(generation.cancelled??0)>=check.generation)return;
     if(!current||current.rev!==task.rev||generation?.generation!==check.generation||generation.verified>=generation.generation||!TERMINAL_STATES.includes(current.state)) {
      database(ctx).query('UPDATE agent_session_checks SET generation=generation+1,checking=0 WHERE task=? AND generation=? AND verified<generation').run(task.id,check.generation);return;
     }
       updateTask(ctx,task.id,t=>{
       t.result={...(t.result??{status:t.state as "done",executor:null,model:null,report:"Agent sessions ended",backend:"direct"}),...verification};
       if(verification.acceptance&&!verification.acceptance.passed){t.state='partial';t.result.status='partial';}
      });
      database(ctx).query('UPDATE agent_session_checks SET verified=generation,checking=0 WHERE task=?').run(task.id);
     }).immediate();
    },{staleMs:600000});
   }finally{clearInterval(heartbeat);}
  }));
 }
}
const pending=new Set<string>();
/** Supervision remains responsive while bounded repository checks run in the background. */
export function superviseAgentSessionChecks(ctx:Ctx):void {
 if(pending.has(ctx.pacerHome))return;
 pending.add(ctx.pacerHome);
 void settleAgentSessionChecks(ctx).catch(()=>{console.error('Task agent checks remain pending; inspect the task workspace and retry supervision.');}).finally(()=>pending.delete(ctx.pacerHome));
}

export function agentCheckDirectory(ctx:Ctx,check:AgentCheck):string {return join(ctx.pacerHome,'agent-checks',check.task,String(check.generation));}
/** Stop the exact durable checker before releasing its generation. */
export async function stopAgentSessionChecks(ctx:Ctx,task:string,generation?:number):Promise<boolean> {
  // Persist the exact generation before the first await, even when claim owns
  // agent-sessions while waiting for session-create. Never cancel a later retry.
  const checks = database(ctx).transaction(() => {
    const selected = pendingAgentChecks(ctx).filter(c=>c.task===task&&(generation===undefined||c.generation===generation));
    for (const check of selected) database(ctx).query('UPDATE agent_session_checks SET cancelled=? WHERE task=? AND generation=? AND verified<generation').run(check.generation,task,check.generation);
    return selected;
  }).immediate();
  for(const check of checks) {
   await stopRun(agentCheckDirectory(ctx,check),{graceMs:2000});
   if(readRun(agentCheckDirectory(ctx,check)).alive)throw new CoreError('conflict','Task checks could not be stopped; checkout remains reserved');
  // The supervisor may still be capturing the diff after its child exits. Do
  // not release checkout ownership until that entire clean-lock scope ends.
  await withLock(ctx,`clean-${task}`,async()=>{
   database(ctx).query('UPDATE agent_session_checks SET verified=generation,checking=0 WHERE task=? AND generation=?').run(task,check.generation);
   });
  }
  return checks.length>0;
}
