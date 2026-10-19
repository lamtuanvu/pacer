import { settingsMigrationMessage } from "../../../../src/view-model/feedback";
import { SectionHeading } from "../../ds/SectionHeading";
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Job } from '../../../../src/api/read-model/types';
import type { BrowserApi } from '../../data/api';
import { useActions } from '../../data/action-context';
import { Button } from '../../ds/Button';
import { ErrorMessage, useTaskContext } from '../task-shared';
import styles from './settings.css' with {type:'text'};
const styledDocuments = new WeakSet<Document>();
/** Constructed sheets keep these standalone screens compatible with the app's strict style CSP. */
function useSettingsStyles() {
 useEffect(()=>{if(styledDocuments.has(document))return;const sheet=new CSSStyleSheet();sheet.replaceSync(styles);document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];styledDocuments.add(document);},[]);
}
export function latestJob(event:Job|undefined,polled:Job|undefined):Job|undefined {
 if(event&&event.state!=='running')return event;
 return polled??event;
}
export function Section({id,title,detail,actions,children}:{id:string;title:string;detail?:string;actions?:ComponentChildren;children:ComponentChildren}) {
 return <section id={id} className="u3-section"><div className="u3-heading"><div><SectionHeading>{title}</SectionHeading>{detail&&<p>{detail}</p>}</div><div className="u3-actions">{actions}</div></div>{children}</section>;
}
export function useResource<T>(op:string,params:unknown={},initial?:T) {
 useSettingsStyles();
 const {api,state}=useTaskContext();const [data,setData]=useState(initial),[error,setError]=useState<unknown>(),[loading,setLoading]=useState(initial===undefined),[revision,reload]=useState(0);
 const serialized=JSON.stringify(params),invalidations=JSON.stringify(state.invalidations);
 useEffect(()=>{let active=true;setLoading(true);setError(undefined);void api.call<T>(op,JSON.parse(serialized)).then(r=>{if(active)setData(r);},e=>{if(active)setError(e);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[api,op,serialized,revision,invalidations,state.connected]);
 return {data,error,loading,reload:()=>reload(v=>v+1)};
}
export function ResourceState({resource,empty,children}:{resource:{data:unknown;loading:boolean;error:unknown;reload:()=>void};empty?:string;children:ComponentChildren}) {
 if(resource.error)return <><ErrorMessage error={resource.error}/><Button onClick={resource.reload}>Try again</Button></>;
 if(resource.data===undefined)return <p role="status">{resource.loading?'Loading…':'No data available.'}</p>;
 if(Array.isArray(resource.data)&&resource.data.length===0)return <p className="u3-muted">{empty??'Nothing here yet.'}</p>;
 return <>{children}</>;
}
export interface OperationResult {data:unknown;message:string;hint?:string;command?:string;job?:Job;jobId?:string;path?:string;undo?:string}
export async function performOperation(call:BrowserApi['call'],op:string,params:unknown):Promise<OperationResult> {
 const data=await call<unknown>(op,params),r=(data&&typeof data==='object'?data:{}) as Record<string,unknown>;
 const candidate=(r.job??(r.steps&&r.id?r:undefined)) as Job|string|undefined;
 return {data,path:typeof r.path==='string'?r.path:undefined,undo:typeof r.undo==='string'?r.undo:undefined,message:typeof r.message==='string'?r.message:typeof r.opened==='boolean'?r.opened?'Opened in terminal.':'Run this command in a terminal.':candidate?'Check progress below.':'Saved.',hint:typeof r.hint==='string'?r.hint:r.migrated?settingsMigrationMessage:undefined,command:typeof r.command==='string'?r.command:undefined,...(typeof candidate==='string'?{jobId:candidate}:candidate?{job:candidate,jobId:candidate.id}:{})};
}
export function useOperation(onDone?:()=>void) {
 const runner=useActions();
 const {api,state}=useTaskContext(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[result,setResult]=useState<OperationResult>();const pending=useRef(false);
 const jobId=result?.jobId, eventJob=jobId?state.jobs[jobId]:undefined;
 const job=latestJob(eventJob,result?.job);
 const completed=useRef<string>();
 useEffect(()=>{if(!jobId||job&&job.state!=='running')return;let active=true;let timer:ReturnType<typeof setTimeout>;
 const poll=async()=>{try{const current=await api.call<Job>('job.get',{id:jobId});if(active)setResult(r=>r?{...r,job:current}:r);}catch(e){if(active)setError(e);}if(active)timer=setTimeout(poll,1500);};void poll();return()=>{active=false;clearTimeout(timer);};},[api,jobId,job?.state]);
 useEffect(()=>{if(job&&job.state!=='running'&&completed.current!==job.id){completed.current=job.id;onDone?.();}},[job]);
 async function run(op:string,params:unknown,done?:(data:any)=>void) {
  if(pending.current)return;pending.current=true;setBusy(true);setError(undefined);setResult(undefined);
  try{const r=await performOperation(async <T,>(operation:string,payload:unknown)=>{
   const key=`settings:${operation}:${JSON.stringify(payload)}`;
   const outcome=await runner.run(key,{label:operation,op:operation,params:payload as Record<string,unknown>});
   if(outcome.status==='error'||outcome.status==='handled')throw new Error(outcome.message+('hint' in outcome&&outcome.hint?` · ${outcome.hint}`:''));
   return runner.result(key) as T;
  },op,params);setResult(r);await done?.(r.data);if(!r.jobId)onDone?.();return r;}
  catch(e){setError(e);}finally{pending.current=false;setBusy(false);}
 }
 return {busy:busy||job?.state==='running',error,result,job,run};
}
export function JobProgress({job}:{job:Job}) {
 return <div className="u3-progress" role="status" aria-live="polite"><strong>{job.kind} · {job.state}</strong><ul>{job.steps.map((step,i)=><li key={i}><span className={`u3-status u3-status--${step.state}`}>{step.state}</span> {step.name}{step.detail&&<span className="u3-muted"> · {step.detail}</span>}</li>)}</ul>{job.error&&<><p>{job.error.message}</p>{job.error.hint&&<p>{job.error.hint}</p>}</>}</div>;
}
export function Feedback({action}:{action:ReturnType<typeof useOperation>}) {
 return <div className="u3-feedback" aria-live="polite"><ErrorMessage error={action.error}/>{action.result&&<><span>{action.result.message}</span>{action.result.hint&&<p>{action.result.hint}</p>}{action.result.command&&<pre>{action.result.command}</pre>}{action.result.path&&<p>Path: <code>{action.result.path}</code></p>}{action.result.undo&&<p>Undo: <code>{action.result.undo}</code></p>}</>}{action.job&&<JobProgress job={action.job}/>}</div>;
}
export function Segment({label,value,options,onChange,disabled}:{label:string;value:string;options:{value:string;label:string}[];onChange:(value:string)=>void;disabled?:boolean}) {
 return <div className="u3-segment" role="group" aria-label={label}>{options.map(option=><Button size="sm" key={option.value} disabled={disabled} aria-pressed={value===option.value} onClick={()=>onChange(option.value)}>{option.label}</Button>)}</div>;
}
export function Field({label,children,help}:{label:string;children:ComponentChildren;help?:string}) {return <label className="u3-field"><span>{label}</span>{children}{help&&<small>{help}</small>}</label>;}
export const words=(value:string)=>value.replaceAll('_',' ');
export const time=(value:number|null)=>value===null?'Not checked':new Date(value*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
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
