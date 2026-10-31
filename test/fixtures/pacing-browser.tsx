import {render} from 'preact';
import {PlannerPacing} from '../../app/src/screens/settings/General';
import {TaskContext} from '../../app/src/screens/task-shared';
import {ActionContext} from '../../app/src/data/action-context';
import {createActionRunner} from '../../app/src/data/actions';
import {initialState} from '../../app/src/data/store';
import {ApiError,type BrowserApi} from '../../app/src/data/api';
import snapshot from './ui/snapshot.json';
const call:BrowserApi['call']=async<T,>(op:string,params:unknown)=>{
 const response=await fetch(`/ops/${op}`,{method:'POST',body:JSON.stringify(params)});
 const value=await response.json();
 if(!response.ok)throw new ApiError(value.code,value.message);
 return value as T;
};
const api={call} as BrowserApi;
const runner=createActionRunner({call,waitFor:async()=>true,refetch:()=>{},navigate:()=>{}});
const state={...initialState(),connected:true,snapshot:{...snapshot,planner:{...snapshot.planner,mode:'normal',modeHeldUntil:undefined}}} as any;
render(<TaskContext.Provider value={{state,api}}><ActionContext.Provider value={runner}><PlannerPacing/></ActionContext.Provider></TaskContext.Provider>,document.getElementById('root')!);
