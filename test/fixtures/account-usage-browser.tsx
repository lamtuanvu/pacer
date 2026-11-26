import {NotificationProvider} from '../../app/src/data/notification-context';
import {useOperation} from '../../app/src/screens/settings/shared';
import {Button} from '../../app/src/ds/Button';
import {render} from 'preact';
import {TaskContext} from '../../app/src/screens/task-shared';
import {ActionContext} from '../../app/src/data/action-context';
import {createActionRunner} from '../../app/src/data/actions';
import {initialState} from '../../app/src/data/store';
import {AgentsPage} from './ui/agents';
const api={call:async(op:string,params:any)=>{
 const response=await fetch(`/ops/${op}`,{method:'POST',body:JSON.stringify(params)});
 const result=await response.json();if(!response.ok)throw Error(result.message);return result;
}} as any;
const actions=createActionRunner({call:api.call,waitFor:async()=>true,refetch:()=>{},navigate:()=>{}});
// One agent per account, so each account's usage card renders in Dispatcher › Agents.
const agentOf=(kind:string)=>kind==='claude'?'claude-code':kind==='endpoint'?'opencode':kind;
const accounts:any[]=await api.call('account.list',{});
const executors=accounts.map(account=>({id:`${agentOf(account.kind)}#${account.name}`,agent:agentOf(account.kind),account:account.name,host:null,model:null,rank:1,enabled:true,state:'ready',tone:'good',sub:'',usedPct:null,pacePct:null,slots:{used:0,max:1},lastCheck:null,recentFailures:0,next:false}));
const state={...initialState(),connected:true,snapshot:{at:1800000000,accounts:[],executors,hosts:[],repos:[]}} as any;
state.snapshot.accounts = await api.call('fixture.snapshot', {});
function DefaultOperation(){const action=useOperation(undefined,{notifySuccess:false});return <Button onClick={()=>void action.run('account.usage.check',{account:'default'})}>Default operation</Button>;}
const renderApp = () => render(<TaskContext.Provider value={{state,api}}><ActionContext.Provider value={actions}><NotificationProvider><div className="u3-settings">
 {executors.map(executor=><div key={executor.id} data-account={executor.account}><AgentsPage agent={executor.id} initialConfig={{keys:{},planners:[]} as any}/></div>)}
 {location.search.includes('default-operation')&&<DefaultOperation/>}</div></NotificationProvider></ActionContext.Provider></TaskContext.Provider>,document.getElementById('root')!);

(window as any).setFixtureSnapshot = (accounts:any[]) => {state.snapshot = {...state.snapshot,accounts}; renderApp();};
renderApp();
