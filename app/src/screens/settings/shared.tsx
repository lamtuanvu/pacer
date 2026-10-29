import { useNotifications } from "../../data/notification-context";
import { Alert } from "../../ds/Alert";
import { createContext } from 'preact';
import { jobKindCopy, jobStateCopy } from "../../../../src/view-model/copy";
import { SegmentedControl, LoadingState, EmptyState, TextRow } from "../../ds/Patterns";
export { Field } from "../../ds/Controls";
import { clock } from "../../../../src/view-model/time";
import { settingsMigrationMessage } from "../../../../src/view-model/feedback";
import { SectionHeading } from "../../ds/SectionHeading";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from 'preact';
import type { Job } from '../../../../src/api/read-model/types';
import type { BrowserApi } from '../../data/api';
import { useActions } from "../../data/action-context";
import { Button } from "../../ds/Button";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { withQuery, type RouteQuery } from "../../router";
import styles from './settings.css' with {type:'text'};
const styledDocuments = new WeakSet<Document>();
/** Constructed sheets keep these standalone screens compatible with the app's strict style CSP. */
export function useSettingsStyles() {
 useEffect(()=>{if(styledDocuments.has(document))return;const sheet=new CSSStyleSheet();sheet.replaceSync(styles);document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];styledDocuments.add(document);},[]);
}
export function latestJob(event:Job|undefined,polled:Job|undefined):Job|undefined {
 if(event&&event.state!=='running')return event;
 return polled??event;
}
export const SettingsPageContext = createContext<string | null>(null);
/** The route's repo and scope, so links between settings pages keep them. */
export const SettingsQueryContext = createContext<RouteQuery>({ repo: null, scope: null });
export function useScoped() { const query = useContext(SettingsQueryContext); return (href: string) => withQuery(href, query); }

export function Section({id,title,detail,actions,children,step}:{id:string;title:string;detail?:string;actions?:ComponentChildren;children:ComponentChildren;step?:number}) {
 useSettingsStyles();
 const page = useContext(SettingsPageContext) === id;
 if (step !== undefined) return <section aria-label={title} id={id} className="pc-settings-step"><span className="pc-settings-step__number" aria-hidden="true">{step}</span><div className="pc-settings-step__body"><div className="pc-settings-step__heading"><h2>{title}</h2>{detail && <p>{detail}</p>}{actions}</div>{children}</div></section>;
 return <section aria-label={title} id={id} className="u3-section">{(!page || detail || actions) && <div className="u3-heading"><div>{!page && <SectionHeading>{title}</SectionHeading>}{detail&&<p>{detail}</p>}</div><div className="u3-actions">{actions}</div></div>}{children}</section>;
}
export function resourceRevision(op: string, invalidations: Record<string, number>): string {
 // update.check itself publishes an update event; reacting to it creates a request loop.
 return JSON.stringify(Object.entries(invalidations).filter(([area]) => op.startsWith("plugin.") ? area === "plugin" || area === "plugins" : area !== "plugin" && (op !== "update.check" || area !== "update")));
}
export function useResource<T>(op:string,params:unknown={},initial?:T) {
 useSettingsStyles();
 const {api,state}=useTaskContext();const [data,setData]=useState(initial),[error,setError]=useState<unknown>(),[loading,setLoading]=useState(initial===undefined),[revision,reload]=useState(0);
 const generation=useRef(0);
 const serialized=JSON.stringify(params),invalidations=resourceRevision(op,state.invalidations);
 useEffect(()=>{let active=true;const ticket=++generation.current;setLoading(true);setError(undefined);void api.call<T>(op,JSON.parse(serialized)).then(r=>{if(active&&ticket===generation.current)setData(r);},e=>{if(active&&ticket===generation.current)setError(e);}).finally(()=>{if(active&&ticket===generation.current)setLoading(false);});return()=>{active=false;};},[api,op,serialized,revision,invalidations,state.connected]);
 return {data,error,loading,setData:(next:T)=>{generation.current++;setLoading(false);setData(next);},reload:()=>reload(v=>v+1)};
}
export function ResourceState({resource,empty,children}:{resource:{data:unknown;loading:boolean;error:unknown;reload:()=>void};empty?:string;children:ComponentChildren}) {
 if(resource.error)return <><ErrorMessage error={resource.error}/><Button onClick={resource.reload}>Try again</Button></>;
 if(resource.data===undefined)return resource.loading?<LoadingState/>:<EmptyState title="No data available."/>;
 if(Array.isArray(resource.data)&&resource.data.length===0)return <EmptyState title={empty??'Nothing here yet.'}/>;
 return <>{children}</>;
}
export interface OperationResult {data:unknown;message:string;hint?:string;command?:string;job?:Job;jobId?:string;path?:string;undo?:string}
export async function performOperation(call:BrowserApi['call'],op:string,params:unknown):Promise<OperationResult> {
 const data=await call<unknown>(op,params),r=(data&&typeof data==='object'?data:{}) as Record<string,unknown>;
 const candidate=(r.job??(r.steps&&r.id?r:undefined)) as Job|string|undefined;
 return {data,path:typeof r.path==='string'?r.path:undefined,undo:typeof r.undo==='string'?r.undo:undefined,message:typeof r.message==='string'?r.message:typeof r.opened==='boolean'?r.opened?'Opened in terminal.':'Run this command in a terminal.':candidate?'Check progress below.':'Saved.',hint:typeof r.hint==='string'?r.hint:r.migrated?settingsMigrationMessage:undefined,command:typeof r.command==='string'?r.command:undefined,...(typeof candidate==='string'?{jobId:candidate}:candidate?{job:candidate,jobId:candidate.id}:{})};
}
export function useOperation(onDone?:()=>void, options: {notifySuccess?: boolean} = {}) {
 const notifications=useNotifications();
 const runner=useActions();
 const {api,state}=useTaskContext(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[result,setResult]=useState<OperationResult>();const pending=useRef(false);
 const jobId=result?.jobId, eventJob=jobId?state.jobs[jobId]:undefined;
 const job=latestJob(eventJob,result?.job);
 const completed=useRef<string>();
 useEffect(()=>{if(!jobId||job&&job.state!=='running')return;let active=true;let timer:ReturnType<typeof setTimeout>;
 const poll=async()=>{try{const current=await api.call<Job>('job.get',{id:jobId});if(active)setResult(r=>r?{...r,job:current}:r);}catch(e){if(active)setError(e);}if(active)timer=setTimeout(poll,1500);};void poll();return()=>{active=false;clearTimeout(timer);};},[api,jobId,job?.state]);
 useEffect(()=>{if(job&&job.state!=='running'&&completed.current!==job.id){completed.current=job.id;notifications?.notify({key:`job:${job.id}`,tone:job.state==='passed'?'success':'error',title:job.state==='passed'?'Check completed':'Check needs attention',message:job.error?.message});onDone?.();}},[job]);
 async function run(op:string,params:unknown,done?:(data:any)=>void) {
  if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);setResult(undefined);
  try{const r=await performOperation(async <T,>(operation:string,payload:unknown)=>{
   const key=`settings:${operation}:${JSON.stringify(payload)}`;
   const outcome=await runner.run(key,{label:operation,op:operation,params:payload as Record<string,unknown>});
   if(outcome.status==='error'||outcome.status==='handled')throw new Error(outcome.message+('hint' in outcome&&outcome.hint?` · ${outcome.hint}`:''));
   return runner.result(key) as T;
  },op,params);setResult(r);if(!r.jobId && options.notifySuccess !== false)notifications?.notify({key:`settings:${op}`,tone:"success",title:r.message==="Saved."?"Changes saved":r.message});await done?.(r.data);if(!r.jobId)onDone?.();return r;}
  catch(e){setError(e);}finally{pending.current=false;setBusy(false);}
 }
 return {busy:busy||job?.state==='running',error,result,job,run,clear:()=>{setError(undefined);setResult(undefined);}};
}
export function JobProgress({job}:{job:Job}) {
 return <div className="u3-progress" role="status" aria-live="polite"><TextRow label="Check progress" value={jobKindCopy(job.kind)} meta={jobStateCopy(job.state)} /><ul>{job.steps.map((step,i)=><li key={i}><span className={`u3-status u3-status--${step.state}`}>{jobStateCopy(step.state)}</span> {step.name}{step.detail&&<span className="u3-muted"> · {step.detail}</span>}</li>)}</ul>{job.error&&<Alert tone="error" title={job.error.message} announce={false}>{job.error.hint}</Alert>}</div>;
}
export function Feedback({action}:{action:ReturnType<typeof useOperation>}) {
 const notifications=useNotifications();
 return <div className="u3-feedback"><ErrorMessage error={action.error}/>{action.result&&<>{!notifications&&!action.job&&<span>{action.result.message}</span>}{action.result.hint&&<p>{action.result.hint}</p>}{action.result.command&&<pre>{action.result.command}</pre>}{action.result.path&&<p>Path: <code>{action.result.path}</code></p>}{action.result.undo&&<p>Undo: <code>{action.result.undo}</code></p>}</>}{action.job&&<JobProgress job={action.job}/>}</div>;
}
export function Segment(props:{variant?:"board";label:string;value:string;options:{value:string;label:string}[];onChange:(value:string)=>void;disabled?:boolean}) {return <SegmentedControl {...props}/>;}
export const words=(value:string)=>value.replaceAll('_',' ');
export const time=(value:number|null)=>value===null?'Not checked':clock(value,Date.now()/1000);
/** Keep host jobs visible after navigation or a service reconnect. */
export function JobList({target,onComplete}:{target:string;onComplete:()=>void}) {
 const {state}=useTaskContext(),query=useResource<Job[]>('job.list',{target});
 const jobs=new Map((query.data??[]).map(job=>[job.id,job]));
 for(const event of Object.values(state.jobs))if(event.target===target)jobs.set(event.id,latestJob(event,jobs.get(event.id))!);
 const running=[...jobs.values()].some(job=>job.state==='running'),signature=[...jobs.values()].filter(job=>job.state!=='running').map(job=>`${job.id}:${job.state}`).join('|');
 const last=useRef('');
 useEffect(()=>{if(signature&&last.current!==signature){last.current=signature;onComplete();}},[signature]);
 useEffect(()=>{if(!running)return;const timer=setInterval(query.reload,1500);return()=>clearInterval(timer);},[running]);
 return <><ErrorMessage error={query.error}/>{[...jobs.values()].sort((a,b)=>b.startedAt-a.startedAt).slice(0,3).map(job=><JobProgress key={job.id} job={job}/>)}</>;
}
