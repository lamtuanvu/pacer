import { Button } from "../../ds/Button";
import type { ApiTask } from "../../../../src/api/read-model/types";
import { sessionTime, timelineCopy } from "../../../../src/view-model/copy";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TaskDetail } from '../../../../src/core/task-detail';
import type { ClientTask } from '../../../../src/view-model/snapshot';
import { markAgent } from "../../../../src/view-model/agents";
import { clock } from "../../../../src/view-model/time";
import { scopedTaskTree, taskTree, workTasks, type WorkRow } from "../../../../src/view-model/task-tree";
import { withQuery, type RouteQuery } from "../../router";
import { useQuery, useTaskContext } from "../task-shared";
import { onPageScroll, pageScrollY, scrollPageTo } from "../../shell/page-scroll";
import { TasksPage } from "./TasksPage";
import { Cluster } from "../../ds/Page";
import type { TaskDiff } from "./SessionPanel";
import type { SessionData } from './types';
/** Before the first snapshot arrives, history alone still renders, with the same descriptor. */
function scopedHistory(history:ApiTask[],repo:string|null){
 return taskTree({tasks:history.filter(t=>!repo||t.repo?.key===repo)},{now:Date.now()/1000}).filter(node=>!node.active);
}
export function sessionRow(task:ClientTask):SessionData {
 return {id:task.id,title:task.fullTitle ?? task.title,goal:task.goal,state:task.state,reviewRequest:task.reviewRequest,review:task.review,resolved:task.resolved,dismissed:task.dismissed,retriedBy:task.retriedBy,executor:task.executor,agent:markAgent(task.executor??'unknown'),repo:task.repo?.label??'Repository unknown',machine:task.host,
 phase:task.progress?.phase,elapsed:sessionTime(task,Date.now()/1000),
 changesSummary:task.progress?`${task.progress.files} files · ${task.progress.commits} commits`:undefined};
}
interface TaskListPosition { scroll: number; cursor?: string; history: ApiTask[] }
const taskListPositions = new Map<string, TaskListPosition>();
export function sessionChangeText(diff:TaskDiff):string {
 return `${diff.patch}${diff.untracked.length?'\nUntracked files:\n'+diff.untracked.join('\n'):''}${diff.truncated?'\nDiff truncated.':''}`;
}
export function conversationChanges(diff:TaskDiff):{diff:string;untracked:string[]} {
 return {diff:diff.patch,untracked:diff.untracked};
}

export function Sessions({query}:{query:RouteQuery}) {
 const {state}=useTaskContext(),snapshot=state.snapshot;
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
  // History and the selected-task panel can change the list's height after this
  // effect. Do not remember a clamped position while layout is still catching up.
  const deadline = performance.now() + 1000;
  let frame: number;
  const restore = () => {
   scrollPageTo(savedScroll.current);
   if (Math.abs(pageScrollY() - savedScroll.current) <= 1 || performance.now() >= deadline) {
    scrollRestored.current = true;
   } else {
    frame = requestAnimationFrame(restore);
   }
  };
  frame = requestAnimationFrame(restore);
  return () => cancelAnimationFrame(frame);
 }, [snapshot, page.loading, history]);
 const [workBefore,setWorkBefore]=useState<string|undefined>();
 const [workRows,setWorkRows]=useState<WorkRow[]>([]);
 const work=useQuery<{tasks:WorkRow[];next:string|null}>("dispatch.list",{relation:"all",limit:100,...(workBefore?{before:workBefore}:{}),...(query.repo?{repo:query.repo}:{})});
 useEffect(()=>{if(work.data)setWorkRows(previous=>[...new Map([...(workBefore?previous:[]),...work.data!.tasks].map(row=>[row.id,row])).values()]);},[work.data,workBefore]);
 const extra=useMemo(()=>[...workTasks(workRows),...history],[workRows,history]);
 const nodes=snapshot?scopedTaskTree(snapshot,{repo:query.repo||null},{now:Date.now()/1000,extra}):history.length?scopedHistory(history,query.repo||null):undefined;
 return <TasksPage key={query.repo??''} nodes={nodes} repos={snapshot?.repos??[]} query={query} onNew={()=>window.dispatchEvent(new Event("pacer:delegate"))}
  hasOlder={!!page.data?.next} loadingOlder={page.loading} onLoadOlder={()=>setCursor(page.data!.next!)}
  error={page.error||work.error?<Cluster><span role="alert">{page.error&&work.error?"Tasks and subtasks could not be loaded.":page.error?"Task history could not be loaded.":"Subtasks and branches could not be loaded."}</span><Button onClick={()=>{page.error&&page.reload();work.error&&work.reload();}}>Try again</Button></Cluster>:undefined}
  hasMoreWork={!!work.data?.next} loadingMoreWork={work.loading} onLoadMoreWork={()=>setWorkBefore(work.data!.next!)}/>;
}
export function sessionDetail(task:TaskDetail):SessionData {
 return {...sessionRow(task),branch:task.branch,machine:task.machine,started:task.startedAt?clock(task.startedAt,Date.now()/1000):undefined,
 briefSections:([
  ['Goal',task.brief.goal],['Repository',task.repo.label],['Scope',task.brief.scope],
  ['Constraints',task.brief.constraints],['Context',task.brief.context],['Feedback',task.brief.feedback],['Base',task.brief.base],
  ['Questions and answers',task.brief.qa?.map(item=>`${item.q}\n${item.a}`).join('\n\n')],
 ] as const).filter((item):item is readonly [typeof item[0],string]=>!!item[1]).map(([label,text])=>({label,text})),report:task.summary,
 brief:{data:Object.entries(task.brief).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>`${k}: ${typeof v==='string'?v:JSON.stringify(v)}`).join('\n\n')},doneWhen:{data:task.acceptance.cmd},timeline:{data:timelineCopy(task.timeline).map(e=>({...e,at:clock(e.at,Date.now()/1000)}))}};
}
