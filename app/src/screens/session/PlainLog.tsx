import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../ds/Button';
/** Legacy follow endpoint for tasks without a PTY recording. */
export function PlainLog({id}:{id:string}){
 const [text,setText]=useState(''),[status,setStatus]=useState('Connecting to output…'),[error,setError]=useState(''),[follow,setFollow]=useState(true);
 const box=useRef<HTMLPreElement>(null);
 useEffect(()=>{setText('');setError('');setStatus('Connecting to output…');const stream=new EventSource(`/v2/tasks/${encodeURIComponent(id)}/log?follow=1`);let active=true;
  stream.onopen=()=>{if(active){setText('');setError('');setStatus('Following output');}};
  stream.addEventListener('log',event=>{if(!active)return;try{const chunk=JSON.parse((event as MessageEvent).data);setText(value=>(value+(typeof chunk.stdout==='string'?chunk.stdout:'')+(typeof chunk.stderr==='string'?chunk.stderr:'')).slice(-512*1024));}catch{setError('Could not read this output chunk.');}});
  stream.addEventListener('done',()=>{if(active){setStatus('Output ended');stream.close();}});
  stream.onerror=()=>{if(active)setStatus('Reconnecting to output…');};
  return ()=>{active=false;stream.close();};
 },[id]);
 useEffect(()=>{if(follow&&box.current)box.current.scrollTop=box.current.scrollHeight;},[text,follow]);
 return <><span role="status">{status}</span>{error&&<p role="alert">{error}</p>}<details className="pc-disclosure"><summary>Technical session output</summary><pre ref={box} role="log" aria-label="Session output" tabIndex={0} className="pc-session-follow-log" onScroll={e=>{const node=e.currentTarget;setFollow(node.scrollHeight-node.clientHeight-node.scrollTop<32);}}>{text||'Waiting for output…'}</pre></details>{!follow&&<Button onClick={()=>setFollow(true)}>Follow output</Button>}</>;
}
