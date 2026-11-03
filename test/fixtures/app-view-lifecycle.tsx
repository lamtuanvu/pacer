import { render } from 'preact';
import { useState } from 'preact/hooks';
import { LazyTerminal } from '../../app/src/term/LazyTerminal';
import { PlainLog } from '../../app/src/screens/session/PlainLog';
import { TaskContext } from '../../app/src/screens/task-shared';
import { initialState } from '../../app/src/data/store';
import { ViewActive, WorkspaceIdentity } from '../../app/src/workspace/state';
import { workspaceKey, workspaceManager } from '../../app/src/workspace/manager';
const key=workspaceKey('lifecycle','task');
const fixture={hide:()=>{},evict:()=>{},snapshot:()=>({text:workspaceManager.get(key,'plainLog',''),draft:workspaceManager.get(key,'draft:thread',''),follow:workspaceManager.get(key,'logFollow',true)})};
workspaceManager.set(key,'draft:thread','keep draft');workspaceManager.set(key,'logFollow',false);
const api={hello:async()=>({protocol:'3.0'})} as any;
// PlainLog follows the v3 log stream; replay one chunk and finish.
(window as any).EventSource=class{onopen:any=null;onerror:any=null;listeners:Record<string,(e:any)=>void>={};constructor(){setTimeout(()=>{this.onopen?.({});this.listeners.log?.({data:JSON.stringify({stdout:'log text',stderr:''})});this.listeners.done?.({});},0);}addEventListener(type:string,listener:(e:any)=>void){this.listeners[type]=listener;}close(){}};
function App(){const [active,setActive]=useState(true),[mounted,setMounted]=useState(true);fixture.hide=()=>setActive(false);fixture.evict=()=>setMounted(false);return <TaskContext.Provider value={{api,state:initialState()}}><WorkspaceIdentity.Provider value="lifecycle"><ViewActive.Provider value={active}>{mounted&&<div hidden={!active}><LazyTerminal id="task" url="/session" live control/><PlainLog id="task"/></div>}</ViewActive.Provider></WorkspaceIdentity.Provider></TaskContext.Provider>;}
(window as any).lifecycleFixture=fixture;
render(<App/>,document.getElementById('app')!);
