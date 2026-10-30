import { beginWorkSync, bindOrcaWorkSync, finishOrcaWorkSync, finishWorkSync, withWork } from "../update/desktop/admission";
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../types';
import type { RunIO } from '../supervisor/io';
import { startRun, readRun, stopRun, type RunSpec, type RunState } from '../supervisor/run';
import { OrcaClient, isReady, isLiveTerminal, type WorkerStartOpts } from '../exec/orca/client';
import { loadOrcaState, type OrcaWorkerEntry } from '../exec/orca/state';
import { readTask } from '../tasks/store';
import { CoreError } from '../core/errors';
import { loadStrategy, strategyPath } from '../config/strategy';
import { attachCommand, detectTerminal, hasDesktop, launchViewer, terminalRecipe, validateTaskId, type ViewerTarget } from './targets';
import { takeoverAvailability } from './takeover';
import { hostVersionView, type HostVersionView } from './protocol';
export interface Capabilities { snapshot:boolean; control:boolean; record:boolean; resize:boolean }
export type AttachTarget={kind:'socket';path:string}|{kind:'orca';terminal:string|null};
export interface SessionHost extends RunIO {
 id:'builtin'|'orca'; capabilities:Capabilities;
 start(spec:RunSpec):Promise<{pid:number}|{error:string}>;
 attachTarget():AttachTarget;
}
export class BuiltinSessionHost implements SessionHost {
 readonly id='builtin'; readonly capabilities={snapshot:true,control:true,record:true,resize:true};
 constructor(readonly dir:string){}
 async start(spec:RunSpec){return startRun({...spec,session:spec.session==='interactive'?'interactive':'pty'});}
 async read(){return readRun(this.dir);}
 stop(o:Parameters<RunIO['stop']>[0]){return stopRun(this.dir,o);}
 attachTarget():AttachTarget{return {kind:'socket',path:sessionSocket(this.dir)};}
}
/** Uses the same worker lifecycle and terminal receipts as the Orca backend. */
export class OrcaSessionHost implements SessionHost {
 readonly id='orca';readonly capabilities={snapshot:false,control:false,record:false,resize:false};
 private client:OrcaClient;
 private admission?:string;
 constructor(private ctx:Ctx,private worker:OrcaWorkerEntry){this.client=new OrcaClient(ctx.run,ctx.env);}
 async start(spec:RunSpec & {worker?:WorkerStartOpts}):Promise<{pid:number}|{error:string}>{
  if(!spec.worker)return {error:'Orca sessions require the existing backend worker specification'};
  this.admission=beginWorkSync(this.ctx,{kind:"session",id:this.worker.taskId,label:"Orca session"});
  const r=await this.client.workerStart(spec.worker);if(!r.ok){if(r.error.code==="task_not_startable")finishWorkSync(this.ctx,this.admission);return {error:r.error.message};}
  if(!r.result.dispatchId)return {error:'Orca returned no dispatch id'};
  this.worker.dispatchId=r.result.dispatchId;
  bindOrcaWorkSync(this.ctx,this.admission,{dispatchId:r.result.dispatchId,terminal:this.worker.terminal});
  return {pid:0};
 }
 async read():Promise<RunState>{
  const r=await this.client.workerShow(this.worker.dispatchId);
  if(!r.ok)throw Error(r.error.message);
  const state=r.result.worker?.state;const alive=!!state&&!['succeeded','failed','stopped','cancelled','released'].includes(state);
  return {pid:null,startedAt:this.worker.startedAt,exit:alive?null:state==='succeeded'?0:1,alive,stdoutBytes:0,stderrBytes:0,lastOutputAt:null};
 }
 async stop(_o:Parameters<RunIO['stop']>[0]){const r=await this.client.workerStop(this.worker.dispatchId);if(!r.ok)throw Error(r.error.message);if(this.admission)finishOrcaWorkSync(this.ctx,this.admission,r);return {code:143,killed:false};}
 attachTarget():AttachTarget{return {kind:'orca',terminal:this.worker.terminal};}
}
export function sessionSocket(dir:string){try{return readFileSync(join(dir,'session.sock.path'),'utf8').trim();}catch{return join(dir,'session.sock');}}
export function sessionDirectory(ctx:Ctx,id:string):string|null{
 validateTaskId(id);const task=readTask(ctx,id);if(!task)throw new CoreError('unknown_task',`unknown task ${id}`);
 if(task.run?.dir)return task.run.host&&!existsSync(join(task.run.dir,'session.remote-full'))?null:task.run.dir;
 const root=join(ctx.pacerHome,'runs',id);
 try{const n=task.run?.attempt||Math.max(...readdirSync(root).filter(n=>/^\d+$/.test(n)).map(Number));const dir=Number.isSafeInteger(n)&&n>0?join(root,String(n)):null;return dir&&task.run?.host&&!existsSync(join(dir,"session.remote-full"))?null:dir;}catch{return null;}
}
function sessionProcessAlive(dir:string):boolean{
 try{
  const pid=Number(readFileSync(join(dir,existsSync(join(dir,'session.remote-full'))?'session.bridge.pid':'pid'),'utf8'));
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}
 }catch{return false;}
}
export interface SessionInfo {takeover:{available:boolean;reason?:string};driving:boolean;host:'builtin'|'orca'|'none';capabilities:Capabilities;live:boolean;machine:string|null;attempt?:number|null;cols:number;rows:number;controller:string|null;viewers:number;targets:ViewerTarget[];attach:{cli:string;ws:string};hostVersion?:HostVersionView}
function json(path:string):any{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return {};}}
export async function sessionInfo(ctx:Ctx,id:string,orcaLive?:boolean,includeTargets=true):Promise<SessionInfo>{
 validateTaskId(id);const task=readTask(ctx,id);if(!task)throw new CoreError('unknown_task',`unknown task ${id}`);
 const info:SessionInfo={takeover:takeoverAvailability(task),driving:task.takeover?.state==='driving',host:'none',capabilities:{snapshot:false,control:false,record:false,resize:false},live:false,machine:task.run?.host??null,attempt:task.run?.attempt??null,cols:120,rows:40,controller:null,viewers:0,targets:[],attach:{cli:attachCommand(id),ws:`/v2/tasks/${id}/session`}};
 const worker=Object.values(loadOrcaState(ctx).workers).find(w=>w.taskId===id);
 if(worker || (task.result?.backend??task.backend)==='orca'){
  info.host='orca';if(worker?.terminal){try{info.live=orcaLive??isLiveTerminal(await new OrcaClient(ctx.run,ctx.env).terminalShow(worker.terminal));}catch{}}
  if(info.live)info.targets=['orca'];return info;
 }
 const dir=sessionDirectory(ctx,id);
 if(!dir||(!existsSync(join(dir,'session.log'))&&!existsSync(join(dir,'session.ckpt'))))return info;
 info.host='builtin';info.capabilities=new BuiltinSessionHost(dir).capabilities;
 info.hostVersion=hostVersionView(dir);
 const state=json(join(dir,'session.state')),ckpt=json(join(dir,'session.ckpt'));
 info.cols=state.cols??ckpt.cols??120;info.rows=state.rows??ckpt.rows??40;
 info.live=existsSync(sessionSocket(dir))&&!existsSync(join(dir,'exit'))&&sessionProcessAlive(dir);
 info.controller=info.live&&typeof state.controller==='string'?state.controller:null;
 info.viewers=info.live?Math.max(0,Math.min(16,Number(state.viewers)||0)):0;
 info.targets=['here'];if(!includeTargets)return info;if(info.live)info.targets.unshift('app');
 try{const ready=await new OrcaClient(ctx.run,ctx.env).status();if(isReady(ready))info.targets.push('orca');}catch{}
 if(terminalSetting(ctx))info.targets.push('terminal');if(ctx.env.TMUX&&ctx.which('tmux'))info.targets.push('tmux');
 return info;
}
export function terminalSetting(ctx:Ctx,platform:NodeJS.Platform=process.platform):string|null{
 if(!hasDesktop(ctx,platform))return null;
 try{
  const setting=loadStrategy(ctx).terminal?.open;
  if(setting&&setting!=='auto')return setting;
  if(!setting&&platform==='darwin'){
   const raw=Bun.YAML.parse(readFileSync(strategyPath(ctx),'utf8')) as {terminal?:{app?:string}};
   const legacy:Record<string,string>={Terminal:'terminal-app',iTerm:'iterm',Ghostty:'ghostty'};
   if(raw?.terminal?.app&&legacy[raw.terminal.app])return legacy[raw.terminal.app];
  }
  return detectTerminal(ctx,platform);
 }catch{return detectTerminal(ctx,platform);}
}
export async function openSession(ctx:Ctx,id:string,target:ViewerTarget):Promise<{opened:boolean;command?:string}>{
 return withWork(ctx,{kind:"operation",id,label:"Opening session viewer"},()=>openSessionAdmitted(ctx,id,target));
}
async function openSessionAdmitted(ctx:Ctx,id:string,target:ViewerTarget):Promise<{opened:boolean;command?:string}>{
 const fallback={opened:false,command:attachCommand(id)};const info=await sessionInfo(ctx,id);
 if(!info.targets.includes(target)||target==='app'||target==='here')return fallback;
 try{
  if(target==='orca'){
   const client=new OrcaClient(ctx.run,ctx.env),worker=Object.values(loadOrcaState(ctx).workers).find(w=>w.taskId===id);
   const task=readTask(ctx,id)!;
   const r=info.host==='orca'&&worker?.terminal
    ?await client.call(['terminal','switch','--terminal',worker.terminal])
    :await client.call(['terminal','create','--worktree',`path:${task.result?.worktree??task.worktree??task.brief.repo}`,'--title',`pacer ${id}`,'--command',attachCommand(id)]);
   return r.ok?{opened:true}:fallback;
  }
  const argv=target==='tmux'?['tmux','split-window',attachCommand(id)]:terminalRecipe(terminalSetting(ctx)!,id);
  if(target==='terminal')return await launchViewer(ctx,argv,process.platform==='darwin'&&['open','osascript'].includes(argv[0]!))?{opened:true}:fallback;
  const r=await ctx.run(argv,15_000,{env:ctx.env});return r.code===0?{opened:true}:fallback;
 }catch{return fallback;}
}
