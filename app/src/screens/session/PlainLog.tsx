import { platform } from "../../platform";
import type { BrowserApi } from "../../data/api";
import { useTaskContext } from "../task-shared";
import { Disclosure } from "../../ds/Controls";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../ds/Button";
type LogHandlers = { open: () => void; log: (event: MessageEvent) => void; done: () => void; error: (error?: unknown) => void };
type LogSource = { onopen: ((event: Event) => void) | null; onerror: ((event: Event) => void) | null; addEventListener(type: string, listener: (event: MessageEvent) => void): void; close(): void };
/** Use the API client's negotiated hello, including its existing older-service fallback. */
export function followLog(api: Pick<BrowserApi,"hello">, id: string, handlers: LogHandlers, Source?: new (url: string) => LogSource) {
 let active=true,stream:LogSource|undefined;
 void api.hello().then(hello=>{
  if(!active)return;
  const path=(`/v${hello.protocol.split('.')[0]==='3'?3:2}/tasks/${encodeURIComponent(id)}/log?follow=1`);
  stream=Source?new Source(path):platform.subscribeEvents(path);
  stream.onopen=()=>{if(active)handlers.open();};
  stream.addEventListener('log',event=>{if(active)handlers.log(event);});
  stream.addEventListener('done',()=>{if(active){handlers.done();active=false;stream?.close();}});
  stream.onerror=()=>{if(active)handlers.error();};
 }).catch(error=>{if(active)handlers.error(error);});
 return ()=>{active=false;stream?.close();};
}
/** Follow output for tasks without a PTY recording. */
export function PlainLog({id}:{id:string}){
 const [text,setText]=useState(''),[status,setStatus]=useState('Connecting to output…'),[error,setError]=useState(''),[follow,setFollow]=useState(true);
 const box=useRef<HTMLPreElement>(null);
 const {api,state}=useTaskContext();
 useEffect(()=>{setText('');setError('');setStatus('Connecting to output…');return followLog(api,id,{
  open:()=>{setText('');setError('');setStatus('Following output');},
  log:event=>{try{const chunk=JSON.parse(event.data);setText(value=>(value+(typeof chunk.stdout==='string'?chunk.stdout:'')+(typeof chunk.stderr==='string'?chunk.stderr:'')).slice(-512*1024));}catch{setError('Could not read this output chunk.');}},
  done:()=>setStatus('Output ended'),
  error:error=>{if(error){setStatus('Could not connect to output');setError(error instanceof Error?error.message:'Could not connect to output.');}else setStatus('Reconnecting to output…');},
 });},[api,id,state.connectionRevision]);
 useEffect(()=>{if(follow&&box.current)box.current.scrollTop=box.current.scrollHeight;},[text,follow]);
 return <><span role="status">{status}</span>{error&&<p role="alert">{error}</p>}<Disclosure className="pc-disclosure" summary={<>Technical session output</>}><pre ref={box} role="log" aria-label="Session output" tabIndex={0} className="pc-session-follow-log" onScroll={e=>{const node=e.currentTarget;setFollow(node.scrollHeight-node.clientHeight-node.scrollTop<32);}}>{text||'Waiting for output…'}</pre></Disclosure>{!follow&&<Button onClick={()=>setFollow(true)}>Follow output</Button>}</>;
}
