import {NotificationProvider} from '../../app/src/data/notification-context';
import {useOperation} from '../../app/src/screens/settings/shared';
import {Button} from '../../app/src/ds/Button';
import {render} from 'preact';
import {AccountsSection} from '../../app/src/screens/settings/Accounts';
import {TaskContext} from '../../app/src/screens/task-shared';
import {ActionContext} from '../../app/src/data/action-context';
import {createActionRunner} from '../../app/src/data/actions';
import {initialState} from '../../app/src/data/store';
const api={call:async(op:string,params:any)=>{
 const response=await fetch(`/ops/${op}`,{method:'POST',body:JSON.stringify(params)});
 const result=await response.json();if(!response.ok)throw Error(result.message);return result;
}} as any;
const actions=createActionRunner({call:api.call,waitFor:async()=>true,refetch:()=>{},navigate:()=>{}});
const state={...initialState(),connected:true,snapshot:{at:1800000000,accounts:[],executors:[],hosts:[],repos:[]}} as any;
state.snapshot.accounts = await api.call('fixture.snapshot', {});
function DefaultOperation(){const action=useOperation(undefined,{notifySuccess:false});return <Button onClick={()=>void action.run('account.usage.check',{account:'default'})}>Default operation</Button>;}
const renderApp = () => render(<TaskContext.Provider value={{state,api}}><ActionContext.Provider value={actions}><NotificationProvider><div className="u3-settings"><AccountsSection initialConfig={{keys:{},planners:[]} as any}/>{location.search.includes('default-operation')&&<DefaultOperation/>}</div></NotificationProvider></ActionContext.Provider></TaskContext.Provider>,document.getElementById('root')!);

(window as any).setFixtureSnapshot = (accounts:any[]) => {state.snapshot = {...state.snapshot,accounts}; renderApp();};
renderApp();
