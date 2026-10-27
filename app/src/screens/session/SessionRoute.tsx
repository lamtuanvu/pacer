import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { TaskDetail } from '../../../../src/core/task-detail';
import type { SessionInfo } from '../../../../src/session/service';
import { reasonCopy, sessionTime } from "../../../../src/view-model/copy";
import { markAgent } from "../../../../src/view-model/agents";
import { taskStatus } from "../../../../src/view-model/words";
import { useDialogs } from "../../ds/useDialogs";
import { keys } from "../../keys/instance";
import { useActions } from "../../data/action-context";
import { useFrame } from "../../shell/slots";
import { useQuery, useTaskContext } from "../task-shared";
import { takeoverSession, type TakeoverState } from "./takeover";
import { sessionChangeText, sessionDetail } from "./controller";
import { Brief, Session } from "./Session";
import { Conversation, type SessionSlots } from "./Conversation";
import { SessionPanel, SessionTitle, WorktreeChanges, type SessionPanelTab, type TaskDiff } from "./SessionPanel";
import type { Action } from './types';

/** A task's session: the terminal in the page, its facts and End session in the title bar, Changes and Details in the right panel. */
export function SessionRoute({id, result, work}:{id:string; result?:ComponentChildren; work?:ComponentChildren}) {
 const {state,api}=useTaskContext(),runner=useActions(),frame=useFrame();
 const [panelTab,setPanelTab]=useState<SessionPanelTab>('details');
 const dialogs=useDialogs();
 const [shortcutError,setShortcutError]=useState('');
 const [takeoverBusy,setTakeoverBusy]=useState(false),[takeoverStarting,setTakeoverStarting]=useState(false),[takeoverError,setTakeoverError]=useState(''),[takeRequested,setTakeRequested]=useState(false);
 const takeoverState=useRef<TakeoverState>(),takeoverAbort=useRef<AbortController>();
 const task=useQuery<TaskDetail>('task.get',{id}),session=useQuery<SessionInfo>('task.session',{id}),diff=useQuery<TaskDiff>('task.diff',{id});
 const takeOver=async(initial?:TakeoverState)=>{
  if(takeoverAbort.current)return;
  const abort=new AbortController();takeoverAbort.current=abort;
  setTakeoverBusy(true);setTakeoverError('');
  try{
   await takeoverSession({id,call:api.call.bind(api),state:initial??takeoverState.current,signal:abort.signal,
    starting:()=>{takeoverState.current='starting';setTakeoverStarting(true);},
    ready:info=>{session.setData(info);setTakeRequested(true);takeoverState.current='driving';}});
   if(!abort.signal.aborted){task.reload();session.reload();}
  }catch(error){if(!abort.signal.aborted)setTakeoverError(message(error)??'Takeover failed');}
  finally{if(!abort.signal.aborted){setTakeoverBusy(false);setTakeoverStarting(false);takeoverAbort.current=undefined;}}
 };
 useEffect(()=>{
  const pending=new URLSearchParams(location.hash.split('?')[1]).get('takeover');
  if(pending==='starting'||pending==='driving'){
   history.replaceState(null,'',location.href.replace(/([?&])takeover=(starting|driving)(&?)/,(_,before,_state,after)=>after?before:''));
   void takeOver(pending);
  }
  return ()=>{takeoverAbort.current?.abort();};
 },[id]);
 const invoke=async(action:Action)=>{
  const confirmation=runner.needsConfirm(action);
  if(confirmation&&!await dialogs.confirm(confirmation,action.label,action.label))return;
  let currentAction=action;
  if(action.op==='task.retry'&&task.data&&['running','queued'].includes(task.data.state)) {
   const stopped=await runner.run(`session:${id}:task.stop`,{label:'Stop',op:'task.stop',params:{id,expect_rev:task.data.rev}});
   if(stopped.status==='error'||stopped.status==='handled')throw new Error(stopped.message);
   const updated=await api.call<TaskDetail>('task.get',{id});
   currentAction={...action,params:{...action.params,expect_rev:updated.rev}};
  }
  const result=await runner.run(`session:${id}:${action.op}`,currentAction);
  if(result.status==='error'||result.status==='handled')throw new Error(result.message);
  const response=runner.result(`session:${id}:${action.op}`) as {retry?:{task_id:string}}|undefined;
  if(response?.retry?.task_id)location.hash=`#/sessions/${encodeURIComponent(response.retry.task_id)}`;
  task.reload();session.reload();
 };
 const actions=state.snapshot?.attention?.filter(a=>a.taskId===id).flatMap(a=>a.actions)??[];
 const active=!!task.data&&['running','queued'].includes(task.data.state);
 const stop=active?(actions.find(a=>a.op==='task.stop')??(task.data?{label:'Stop',op:'task.stop',params:{id,expect_rev:task.data.rev},style:'danger' as const,confirm:'Stop this session and its executor?'}:undefined)):undefined;
 const data=task.data?{...sessionDetail(task.data),session:session.data,sessionLoading:session.loading,sessionError:message(session.error),stop,
 retryOptions:task.data.retryOptions.map(option=>({id:option.id,agent:markAgent(option.id),label:option.id,available:option.state==='ready',reason:reasonCopy(option.reason),action:actions.find(a=>a.op==='task.retry'&&a.params.executor===option.id)??{label:active?'Stop and retry':'Retry',op:'task.retry',params:{id,executor:option.id,expect_rev:task.data!.rev},confirm:active?`Stop and retry on ${option.id}?`:undefined}})),
 changes:{data:diff.data?sessionChangeText(diff.data):undefined,loading:diff.loading,error:message(diff.error)}}:undefined;
 const handler=useRef(()=>{});handler.current=()=>{if(stop)void invoke(stop).catch(error=>setShortcutError(message(error)??'Action failed'));};
 useEffect(()=>stop?keys.register({keys:'s',label:'Stop session',scope:'sessions',run:()=>handler.current()}):undefined,[!!stop]);
 const openPanel=(tab:SessionPanelTab)=>{setPanelTab(tab);if(frame?.details&&!frame.details.open)frame.details.toggle();};
 const t=task.data,unsettled=!!t&&!active&&!t.review&&!t.resolved&&!t.dismissed&&!t.retriedBy;
 // One next step per state, in the panel that holds it; a closed panel must not hide it (UI-13, UI-14).
 const next:{label:string;tab:SessionPanelTab}|undefined=!t||!unsettled?undefined
  :t.work?(t.reviewRequest||t.state==='needs_input'?{label:'Review in Work',tab:'work'}:undefined)
  :t.state==='needs_input'&&t.question&&t.question.answer===undefined?{label:'Answer question',tab:'details'}
  :t.reviewRequest||t.acceptance.state==='failed'||['partial','failed','limit'].includes(t.state)?{label:'Review result',tab:'details'}:undefined;
 const slots:SessionSlots|undefined=task.data&&{
  title:actions=><SessionTitle status={taskStatus(task.data!)} live={active} facts={[sessionTime(task.data!,Date.now()/1000),task.data!.repo.label]} actions={actions} next={next&&{...next,open:openPanel}}/>,
  panel:(details,files)=><SessionPanel id={id} tab={panelTab} onTab={setPanelTab} work={work}
   changes={<><WorktreeChanges diff={diff.data} loading={diff.loading} error={diff.error?'Could not load changes. The worktree may have been removed.':undefined}/>{files}</>}
   details={<div className="pc-stack pc-stack--section">{result}{details}{data&&<Brief data={data}/>}</div>}/>,
  showChanges:()=>openPanel('changes'),
 };
 if(task.data?.interactionMode==='conversation')return <Conversation key={id} task={task.data} session={session.data} slots={slots} onReload={()=>{task.reload();session.reload();}}/>;
 return <>{dialogs.dialog}{shortcutError&&<p role="status">{shortcutError}</p>}<Session embedded view="terminal" slots={slots} key={id} onTakeSent={()=>setTakeRequested(false)} onTakeover={()=>void takeOver()} takeoverBusy={takeoverBusy} takeoverStarting={takeoverStarting} takeoverError={takeoverError} takeRequested={takeRequested} data={data} loading={task.loading} error={message(task.error)} onAction={invoke} onAttach={async(_,target)=>{const key=`attach:${id}:${target}`;const outcome=await runner.run(key,{label:'Open viewer',op:'task.attach',params:{id,target}});if(outcome.status==='error'||outcome.status==='handled')throw new Error(outcome.message);return runner.result(key) as {opened:boolean;command?:string};}} onReload={task.reload}/></>;
}
const message=(error:unknown)=>error instanceof Error?error.message:error?String(error):undefined;
