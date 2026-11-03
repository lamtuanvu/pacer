import { parseRunnerId } from '../config/runner-id';
import { createHash } from 'node:crypto';
import { listTasksWhere, readTask } from '../tasks/store';
import type { TaskRecord } from '../tasks/types';
import { CoreError } from '../core/errors';
import { closeSync, fstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openReadOnlyStore, type ReadOnlyStore } from '../dispatch/readonly';
import { readRun } from '../supervisor/run';
import type { Ctx } from '../types';
import type { SlotUse } from '../engine/slots';
import type { StoredAgentSession } from './agents';

/** Shared read-only reservations: reads never create or migrate a database. */
export function activeAgentSessions(ctx:Ctx):StoredAgentSession[] {
 return withSessionSnapshot(ctx, (db, identity) => {
  if(!db.has('agent_sessions'))return [];
  return probeSessions(ctx, lifecycleWatch(ctx, db, identity)).filter(({session, alive}) => session.state === 'starting' || alive)
   .map(({session}) => structuredClone(session));
 });
}
export const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
export function pathsOverlap(a:string,b:string):boolean {
 const x=canonical(a),y=canonical(b);return x===y||x.startsWith(y.endsWith('/')?y:y+'/')||y.startsWith(x.endsWith('/')?x:x+'/');
}
export function workspaceBusy(ctx:Ctx,path:string,exceptTask?:string):boolean {
 return agentWorkspaceBusy(ctx,path,exceptTask)||listTasksWhere(ctx,{states:['queued','running','needs_input']}).some(t=>t.id!==exceptTask&&(t.state!=='needs_input'||!!t.live&&!t.retriedBy)&&!!(t.worktree||t.run?.workdir||t.result?.worktree||t.placement?.requested==='current'||t.placement?.mode==='current')&&pathsOverlap(t.worktree??t.run?.workdir??t.result?.worktree??t.brief.repo,path));
}
/** Called under session-create before a primary backend binding changes. */
export function requireAgentWorkspaceBackend(ctx:Ctx,task:string,backend:string,remote:boolean):void {
 if((backend!=='direct'||remote)&&activeAgentSessions(ctx).some(s=>s.task_id===task))throw new CoreError('conflict','End additional agent sessions before moving this task to another execution host');
}
export async function taskAgentWorkspace(ctx:Ctx,task:TaskRecord):Promise<string> {
 if(task.run?.host||parseRunnerId(task.executor??task.requestedExecutor??task.result?.executor??'')?.host||task.backend==='orca'||task.result?.backend==='orca')throw new CoreError('not_allowed','Additional agents require a local built-in workspace');
 if((task.backend??task.result?.backend)!=='direct')throw new CoreError('conflict','Wait for a confirmed local task backend before adding a session');
 if(!task.worktree)throw new CoreError('conflict','Wait for the task workspace to be established before adding a session');
 let cwd:string;try{cwd=realpathSync(task.worktree);}catch{throw new CoreError('conflict','The task workspace is unavailable; restore it before starting a session');}
 const [source,target]=await Promise.all([task.brief.repo,cwd].map(path=>ctx.run(['git','-C',path,'rev-parse','--path-format=absolute','--git-common-dir'],5000)));
 if(source.code||target.code||!source.stdout.trim()||!target.stdout.trim()||canonical(source.stdout.trim())!==canonical(target.stdout.trim()))throw new CoreError('conflict','The task workspace no longer belongs to its repository; restore it before starting a session');
 return cwd;
}
interface LifecycleWatch { generation:number; identity:string; sessions:StoredAgentSession[]; revision:string }
const lifecycleWatches=new Map<string,LifecycleWatch>();
/** Bracket SQLite acquisition AND all reads, rather than labelling an already-open
 * handle with a later pathname stat. The pinned inode cannot be recycled while
 * we read. ctime also rejects rename-away/restore (ABA) of that file. Concurrent
 * replacement fails closed and no candidate watch survives a failed validation.
 * Like the store itself, this assumes the state directory is not adversarially
 * retargeted while in use; it is not a hostile-filesystem isolation boundary. */
function withSessionSnapshot<T>(ctx: Ctx, read: (db: ReadOnlyStore, identity: string) => T): T {
 const path = join(ctx.pacerHome, 'state', 'tasks.db');
 let fd: number | undefined;
 let db: ReadOnlyStore | undefined;
 const conflict = () => new CoreError('conflict', 'Session reservations changed during acquisition; retry before changing workspaces');
 try {
  try {fd = openSync(path, 'r');}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw conflict();}
  const pinned = fd === undefined ? undefined : fstatSync(fd, {bigint: true});
  const identityOf = (s: NonNullable<typeof pinned>) => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
  const verify = () => {
   let current: typeof pinned;
   try {current = statSync(path, {bigint: true});}
   catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw conflict();}
   if (!pinned) {if (current) throw conflict(); return;}
   const held = fstatSync(fd!, {bigint: true});
   if (!current || identityOf(current) !== identityOf(pinned) || current.ctimeNs !== pinned.ctimeNs || held.ctimeNs !== pinned.ctimeNs) throw conflict();
  };
  verify();
  db = openReadOnlyStore(ctx, true);
  const result = read(db, pinned ? identityOf(pinned) : 'missing');
  verify();
  return result;
 } catch (error) {
  lifecycleWatches.delete(ctx.pacerHome);
  if (error instanceof CoreError) throw error;
  throw conflict();
 } finally {
  try {db?.close();} finally {if (fd !== undefined) closeSync(fd);}
 }
}
function lifecycleWatch(ctx: Ctx, db: ReadOnlyStore, identity: string): LifecycleWatch {
 const generation = db.has('agent_session_revision') ? db.query<{generation:number}>('SELECT generation FROM agent_session_revision WHERE id=1')[0]?.generation : undefined;
 // Identity is captured before opening SQLite and verified after the last read.
 let watch = lifecycleWatches.get(ctx.pacerHome);
 if (generation === undefined || !watch || watch.generation !== generation || watch.identity !== identity) {
  const rows = db.query<{record:string}>('SELECT record FROM agent_sessions ORDER BY id').map(r => {
   try {return JSON.parse(r.record) as StoredAgentSession;}
   catch {throw new CoreError('conflict', 'Session reservations could not be read');}
  });
  watch = {generation: generation ?? -1, identity, sessions: rows.filter(s => s.state !== 'ended'), revision: createHash('sha256').update(JSON.stringify(rows.map(s => [s.id, s.rev, s.state]))).digest('hex')};
  if (lifecycleWatches.size >= 32) lifecycleWatches.delete(lifecycleWatches.keys().next().value!);
  lifecycleWatches.set(ctx.pacerHome, watch);
 }
 return watch;
}
function probeSessions(ctx: Ctx, watch: LifecycleWatch): {session: StoredAgentSession; alive: boolean}[] {
 const observed: {session: StoredAgentSession; alive: boolean}[] = [];
 watch.sessions = watch.sessions.filter(session => {
  const run = readRun(join(ctx.pacerHome, 'agent-sessions', session.id, String(session.attempt)));
  // Only explicit exit evidence retires an immutable attempt. Missing/dead pids
  // can precede a late spawn after a crash; starting always retains its reservation.
  const retain = run.exit === null || session.state === 'starting';
  if (retain) observed.push({session, alive: run.alive});
  return retain;
 });
 return observed;
}
/** Stored mutations invalidate the cache across processes. Only potentially live runs
 * are probed between mutations; retained ended history never incurs idle run reads. */
export function agentSessionsRevision(ctx:Ctx):string {
 return withSessionSnapshot(ctx, (db, identity) => {
  if(!db.has('agent_sessions'))return createHash('sha256').update('[]').digest('hex');
   const watch = lifecycleWatch(ctx, db, identity);
   const live = probeSessions(ctx, watch).map(({session: s, alive}) => [s.id, s.rev, s.state, alive]);
  return createHash('sha256').update(watch.revision===createHash('sha256').update('[]').digest('hex')?'[]':JSON.stringify([watch.revision,live])).digest('hex');
 });
}
export function agentWorkspaceBusy(ctx:Ctx,path:string,exceptTask?:string):boolean {
 if(activeAgentSessions(ctx).some(s=>s.task_id!==exceptTask&&pathsOverlap(s.cwd,path)))return true;
 const db=openReadOnlyStore(ctx,true);
 try {
  if(!db.has('agent_session_checks'))return false;
  // Pending generations retain checkout ownership across service restarts and
  // through acceptance/diff publication, not merely while an agent is alive.
  return db.query<{task:string;workspace?:string}>('SELECT * FROM agent_session_checks WHERE generation>verified').some(check=>{
   if(check.task===exceptTask)return false;
   const task=readTask(ctx,check.task);
   return check.workspace?pathsOverlap(check.workspace,path):!!task&&pathsOverlap(task.worktree??task.run?.workdir??task.brief.repo,path);
  });
 }finally{db.close();}
}
export function addAgentSessionSlots(ctx:Ctx,use:SlotUse,exceptSession?:string):SlotUse {
 for(const s of activeAgentSessions(ctx)) {
  if(s.id===exceptSession)continue;
  use.byExecutor[s.executor]=(use.byExecutor[s.executor]??0)+1;use.local++;
 }
 return use;
}
