import { render } from 'preact';
import { useState } from 'preact/hooks';
import { LazyTerminal } from '../../app/src/term/LazyTerminal';
import { PlainLog } from '../../app/src/screens/session/PlainLog';
import { TaskContext } from '../../app/src/screens/task-shared';
import { initialState } from '../../app/src/data/store';
import { ViewActive, WorkspaceIdentity } from '../../app/src/workspace/state';
import { workspaceKey, workspaceManager } from '../../app/src/workspace/manager';
const key=workspaceKey('lifecycle','task');
const fixture={hide:()=>{},evict:()=>{},snapshot:()=>({text:workspaceManager.get(key,'plainLog',''),cursor:workspaceManager.has(key,'plainLogCursor'),draft:workspaceManager.get(key,'draft:thread',''),follow:workspaceManager.get(key,'logFollow',true)})};
workspaceManager.set(key,'draft:thread','keep draft');workspaceManager.set(key,'logFollow',false);
const api={call:async<T,>()=>({stdout:'log text',stderr:'',next:{stdout:8,stderr:0},source:'fixture',done:true} as T)} as any;
function App(){const [active,setActive]=useState(true),[mounted,setMounted]=useState(true);fixture.hide=()=>setActive(false);fixture.evict=()=>setMounted(false);return <TaskContext.Provider value={{api,state:initialState()}}><WorkspaceIdentity.Provider value="lifecycle"><ViewActive.Provider value={active}>{mounted&&<div hidden={!active}><LazyTerminal id="task" url="/session" live control/><PlainLog id="task"/></div>}</ViewActive.Provider></WorkspaceIdentity.Provider></TaskContext.Provider>;}
(window as any).lifecycleFixture=fixture;
render(<App/>,document.getElementById('app')!);
