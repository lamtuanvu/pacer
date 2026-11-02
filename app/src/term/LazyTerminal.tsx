import { useTaskContext } from "../screens/task-shared";
import { useEffect, useState } from "preact/hooks";
import type { ComponentType } from 'preact';
import type { TerminalViewProps } from './term';
import { Button } from "../ds/Button";
/** No xterm runtime is imported until a terminal surface mounts. */
let resolvedView: ComponentType<TerminalViewProps>|null = null;
export function LazyTerminal(props:TerminalViewProps){
  const context=useTaskContext();
  const attemptStartedAt=context?.state.snapshot?.tasks.find(task=>task.id===props.id)?.attemptStartedAt;
  const [View,setView]=useState<ComponentType<TerminalViewProps>|null>(() => resolvedView),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let active=true;setError('');
  if(!document.querySelector('link[data-pacer-terminal]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/app/term.css';link.dataset.pacerTerminal='true';document.head.append(link);}
  void import('./term').then(module=>{resolvedView = module.TerminalView; if(active)setView(()=>module.TerminalView);}).catch(()=>{if(active)setError('Could not load the terminal.');});return ()=>{active=false;};
 },[attempt]);
 return View?<View {...props} attemptStartedAt={attemptStartedAt}/>:<div className="pc-session-empty" role={error?'alert':'status'}>{error||'Loading terminal…'}{props.takeover}{error&&<Button onClick={()=>setAttempt(n=>n+1)}>Try again</Button>}</div>;
}
