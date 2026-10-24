import { Button } from "../../ds/Button";
import { RepoFilter } from "../RepoFilter";
import type { ApiTask } from "../../../../src/api/read-model/types";
import { reasonCopy, sessionTime, timelineCopy } from "../../../../src/view-model/copy";
import { useDialogs } from "../../ds/useDialogs";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { TaskDetail } from '../../../../src/core/task-detail';
import type { ClientTask } from '../../../../src/view-model/snapshot';
import type { SessionInfo } from '../../../../src/session/service';
import { markAgent } from "../../../../src/view-model/agents";
import { clock } from "../../../../src/view-model/time";
import { running } from "../../../../src/view-model/selectors";
import { withQuery, type RouteQuery } from "../../router";
import { keys } from "../../keys/instance";
import { useActions } from "../../data/action-context";
import { useQuery, useTaskContext } from "../task-shared";
import { Session } from "./Session";
import { onPageScroll, pageScrollY, scrollPageTo } from "../../shell/page-scroll";
import { takeoverSession, type TakeoverState } from "./takeover";
import { SessionsList } from "./SessionsList";
import { Conversation } from "./Conversation";
import type { SessionData, Action } from './types';
export function sessionRow(task:ClientTask):SessionData {
 return {id:task.id,title:task.fullTitle ?? task.title,goal:task.goal,state:task.state,reviewRequest:task.reviewRequest,review:task.review,resolved:task.resolved,dismissed:task.dismissed,retriedBy:task.retriedBy,executor:task.executor,agent:markAgent(task.executor??'unknown'),repo:task.repo?.label??'Repository unknown',machine:task.host,
 phase:task.progress?.phase,elapsed:sessionTime(task,Date.now()/1000),
 changesSummary:task.progress?`${task.progress.files} files · ${task.progress.commits} commits`:undefined};
}
interface TaskListPosition { scroll: number; cursor?: string; history: ApiTask[] }
const taskListPositions = new Map<string, TaskListPosition>();

export function Sessions({query}:{query:RouteQuery}) {
 const {state}=useTaskContext(),snapshot=state.snapshot,runner=useActions();
 const scrollKey = JSON.stringify(query);
 const savedPosition = useRef(taskListPositions.get(scrollKey));
 const savedScroll = useRef(savedPosition.current?.scroll ?? 0);
 const scrollRestored = useRef(false);
 // Match the listener lifetime to the mounted list, before navigation can clamp
 // the document height and dispatch a scroll event for the replacement screen.
 useLayoutEffect(() => {
  const remember = () => {
   const listRoute = ["#/tasks", "#/sessions"].includes(location.hash.split("?")[0]!);
   if (scrollRestored.current && listRoute) {
    const position = taskListPositions.get(scrollKey);
    if (position) position.scroll = pageScrollY();
   }
  };
  return onPageScroll(remember);
 }, [scrollKey]);
 const [cursor,setCursor]=useState<string | undefined>(savedPosition.current?.cursor);
 const [history,setHistory]=useState<ApiTask[]>(savedPosition.current?.history ?? []);
 useEffect(() => {
  taskListPositions.set(scrollKey, {scroll: taskListPositions.get(scrollKey)?.scroll ?? savedScroll.current, cursor, history});
 }, [scrollKey, cursor, history]);
 const page=useQuery<{tasks:ApiTask[];next:string|null}>("task.list",{all:true,limit:20,...(cursor?{before:cursor}:{}),...(query.repo?{repo:query.repo}:{})});
 useEffect(()=>{if(page.data)setHistory(previous=>{
  const rows=cursor?[...previous,...page.data!.tasks]:page.data!.tasks;
  return [...new Map(rows.map(t=>[t.id,t])).values()];
 });},[page.data,cursor]);
 useEffect(() => {
  if (!snapshot || page.loading || scrollRestored.current) return;
  const frame = requestAnimationFrame(() => {
   scrollPageTo(savedScroll.current);
   scrollRestored.current = true;
  });
  return () => cancelAnimationFrame(frame);
 }, [snapshot, page.loading, history]);
 const recent=[...new Map([...history,...(snapshot?.tasks.filter(t=>!query.repo||t.repo?.key===query.repo)??[])].map(t=>[t.id,t])).values()]
  .filter(t=>!['running','queued'].includes(t.state)).sort((a,b)=>b.updatedAt-a.updatedAt);
 const resource=(data:SessionData[]|undefined)=>({data,loading:!snapshot});
 return <>{snapshot&&<RepoFilter snapshot={snapshot} query={query}/>}<SessionsList runner={runner} running={resource(snapshot?running(snapshot,{repo:query.repo||null}).map(sessionRow):undefined)} recent={{data:recent.map(sessionRow),loading:page.loading&&!history.length,error:page.error?'Could not load task history.':undefined}} query={withQuery('',query)}/>
 {page.data?.next&&<Button busy={page.loading} onClick={()=>setCursor(page.data!.next!)}>Load older tasks</Button>}
 {page.error&&<Button onClick={page.reload}>Try again</Button>}</>;
}
export function sessionDetail(task:TaskDetail):SessionData {
 return {...sessionRow(task),branch:task.branch,machine:task.machine,started:task.startedAt?clock(task.startedAt,Date.now()/1000):undefined,
 briefSections:([
  ['Goal',task.brief.goal],['Repository',task.brief.repo],['Scope',task.brief.scope],
  ['Constraints',task.brief.constraints],['Context',task.brief.context],['Feedback',task.brief.feedback],['Base',task.brief.base],
  ['Questions and answers',task.brief.qa?.map(item=>`${item.q}\n${item.a}`).join('\n\n')],
 ] as const).filter((item):item is readonly [typeof item[0],string]=>!!item[1]).map(([label,text])=>({label,text})),report:task.summary,
 brief:{data:Object.entries(task.brief).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>`${k}: ${typeof v==='string'?v:JSON.stringify(v)}`).join('\n\n')},doneWhen:{data:task.acceptance.cmd},timeline:{data:timelineCopy(task.timeline).map(e=>({...e,at:clock(e.at,Date.now()/1000)}))}};
}
export function SessionRoute({id, embedded = false}:{id:string; embedded?:boolean}) {
 const {state,api}=useTaskContext(),runner=useActions();
 const dialogs=useDialogs();
 const [shortcutError,setShortcutError]=useState('');
 const [takeoverBusy,setTakeoverBusy]=useState(false),[takeoverStarting,setTakeoverStarting]=useState(false),[takeoverError,setTakeoverError]=useState(''),[takeRequested,setTakeRequested]=useState(false);
 const takeoverState=useRef<TakeoverState>(),takeoverAbort=useRef<AbortController>();
 const task=useQuery<TaskDetail>('task.get',{id}),session=useQuery<SessionInfo>('task.session',{id}),diff=useQuery<{diff:string;untracked:string[];truncated:boolean}>('task.diff',{id});
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
 changes:{data:diff.data?`${diff.data.diff}${diff.data.untracked.length?'\nUntracked files:\n'+diff.data.untracked.join('\n'):''}${diff.data.truncated?'\nDiff truncated.':''}`:undefined,loading:diff.loading,error:message(diff.error)}}:undefined;
 const handler=useRef(()=>{});handler.current=()=>{if(stop)void invoke(stop).catch(error=>setShortcutError(message(error)??'Action failed'));};
 useEffect(()=>keys.register({keys:'s',label:'Stop session',scope:'sessions',run:()=>handler.current()}),[]);
 if(task.data?.interactionMode==='conversation')return <Conversation key={id} task={task.data} session={session.data} diff={diff.data} onReload={()=>{task.reload();session.reload();}}/>;
 return <>{dialogs.dialog}{shortcutError&&<p role="status">{shortcutError}</p>}<Session embedded={embedded} key={id} onTakeSent={()=>setTakeRequested(false)} onTakeover={()=>void takeOver()} takeoverBusy={takeoverBusy} takeoverStarting={takeoverStarting} takeoverError={takeoverError} takeRequested={takeRequested} data={data} loading={task.loading} error={message(task.error)} onAction={invoke} onAttach={async(_,target)=>{const key=`attach:${id}:${target}`;const outcome=await runner.run(key,{label:'Open viewer',op:'task.attach',params:{id,target}});if(outcome.status==='error'||outcome.status==='handled')throw new Error(outcome.message);return runner.result(key) as {opened:boolean;command?:string};}} onReload={task.reload}/></>;
}
const message=(error:unknown)=>error instanceof Error?error.message:error?String(error):undefined;
