import type { BrowserApi } from "../../data/api";
import { useWorkspaceKey, useWorkspaceState, useViewActive } from '../../workspace/state';
import { Disclosure } from "../../ds/Controls";
import { useEffect, useRef, useState } from "preact/hooks";
import { startPolling } from "../../data/poll";
import { workspaceManager } from "../../workspace/manager";
import { useTaskContext } from "../task-shared";
import { Button } from "../../ds/Button";
type LogHandlers = { open: () => void; log: (event: MessageEvent) => void; done: () => void; error: (error?: unknown) => void };
type LogSource = { onopen: ((event: Event) => void) | null; onerror: ((event: Event) => void) | null; addEventListener(type: string, listener: (event: MessageEvent) => void): void; close(): void };
/** Use the API client's negotiated hello, including its existing older-service fallback. */
export function followLog(api: Pick<BrowserApi,"hello">, id: string, handlers: LogHandlers, Source: new (url: string) => LogSource = EventSource) {
 let active=true,stream:LogSource|undefined;
 void api.hello().then(hello=>{
  if(!active)return;
  stream=new Source(`/v${hello.protocol.split('.')[0]==='3'?3:2}/tasks/${encodeURIComponent(id)}/log?follow=1`);
  stream.onopen=()=>{if(active)handlers.open();};
  stream.addEventListener('log',event=>{if(active)handlers.log(event);});
  stream.addEventListener('done',()=>{if(active){handlers.done();active=false;stream?.close();}});
  stream.onerror=()=>{if(active)handlers.error();};
 }).catch(error=>{if(active)handlers.error(error);});
 return ()=>{active=false;stream?.close();};
}
/** Follow output for tasks without a PTY recording. */
export function PlainLog({id}:{id:string}){
 const key=useWorkspaceKey(id),{api}=useTaskContext();
 const [text,setText]=useWorkspaceState(key,'plainLog',''),[status,setStatus]=useState('Connecting to output…'),[error,setError]=useState(''),[follow,setFollow]=useWorkspaceState(useWorkspaceKey(id), "logFollow", true);
 const visible=useViewActive();
 useEffect(()=>()=>{workspaceManager.remove(key,'plainLog');workspaceManager.remove(key,'plainLogCursor');},[key]);
 const box=useRef<HTMLPreElement>(null);
 useEffect(()=>{
  if(!visible)return;
  let active=true, cursor=workspaceManager.get(key,'plainLogCursor',{stdout:0,stderr:0,source:''});
  const stop=startPolling(async()=>{
   try {
    let chunk=await api.call<{stdout:string;stderr:string;next:{stdout:number;stderr:number};source:string;done:boolean}>('task.log',{id,stdout:cursor.stdout,stderr:cursor.stderr});
    if(!active)return false;
    if(cursor.source&&cursor.source!==chunk.source){chunk=await api.call('task.log',{id});if(!active)return false;setText('');}
    cursor={...chunk.next,source:chunk.source};workspaceManager.set(key,'plainLogCursor',cursor);
    if(chunk.stdout||chunk.stderr)setText(value=>(value+chunk.stdout+chunk.stderr).slice(-512*1024));
    setError('');setStatus(chunk.done?'Output ended':'Following output');
    // A completed log can span several bounded chunks; stop after it is drained.
    if(chunk.done&&!chunk.stdout&&!chunk.stderr)return false;
   }catch{if(active){setStatus('Reconnecting to output…');setError('Could not read output. Retrying…');}}
  },1000);
  return()=>{active=false;stop();};
 },[id,key,visible,api]);
 useEffect(()=>{if(follow&&box.current)box.current.scrollTop=box.current.scrollHeight;},[text,follow]);
 return <><span role="status">{status}</span>{error&&<p role="alert">{error}</p>}<Disclosure className="pc-disclosure" summary={<>Technical session output</>}><pre ref={box} data-scroll-id={`plain-log:${id}`} role="log" aria-label="Session output" tabIndex={0} className="pc-session-follow-log" onScroll={e=>{const node=e.currentTarget;setFollow(node.scrollHeight-node.clientHeight-node.scrollTop<32);}}>{text||'Waiting for output…'}</pre></Disclosure>{!follow&&<Button onClick={()=>setFollow(true)}>Follow output</Button>}</>;
}
