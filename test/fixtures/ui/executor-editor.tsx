import { render } from 'preact';
import { useState } from 'preact/hooks';
import { ExecutorsSection } from '../../../app/src/screens/settings/Executors';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { SettingsPageContext } from '../../../app/src/screens/settings/shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { NotificationProvider } from '../../../app/src/data/notification-context';
import { canLeaveScreen } from '../../../app/src/data/navigation-guard';
import { initialState } from '../../../app/src/data/store';
import { ApiError } from '../../../app/src/data/api';
import type { ExecutorSettings } from '../../../app/src/model/executor-settings';

let settings:ExecutorSettings={revision:'1',order:['codex','claude-code#second'],runners:[{id:'codex',enabled:true,maxTasks:1},{id:'claude-code#second',enabled:true,maxTasks:1}]};
let writes=0,fail=false,hold=false;let release=()=>{};let refresh=()=>{};
const fixture={writes:()=>writes,holdSave:()=>{hold=true;},release:()=>release(),setLimit:(maxTasks:number)=>{settings={...settings,revision:String(Number(settings.revision)+1),runners:settings.runners.map(r=>r.id==='codex'?{...r,maxTasks}:r)};refresh();},settings:()=>settings,fail:(value:boolean)=>{fail=value;},refresh:()=>refresh(),external:()=>{settings={...settings,revision:String(Number(settings.revision)+1)};refresh();},remove:()=>{settings={...settings,revision:String(Number(settings.revision)+1),order:settings.order.filter(id=>id!=='codex'),runners:settings.runners.filter(r=>r.id!=='codex')};refresh();},leave:canLeaveScreen};
Object.assign(window,{executorFixture:fixture});
const api={call:async(op:string,p:any)=>{
 if(op==='runner.settings.get')return structuredClone(settings);
 if(op==='runner.settings.save'){
  writes++;
  if(fail)throw new Error('Service unavailable');
  if(p.expectedRevision!==settings.revision)throw new ApiError('conflict','Settings changed elsewhere');
  settings={revision:String(Number(settings.revision)+1),order:p.order,runners:p.runners};const result={...structuredClone(settings),warnings:[]};refresh();if(hold)await new Promise<void>(resolve=>{release=resolve;});return result;
 }
 return {};
}} as any;
const actions=createActionRunner({call:api.call,waitFor:async()=>true,refetch:()=>{},navigate:()=>{}});
function App(){
 const [tick,setTick]=useState(0);refresh=()=>setTick(t=>t+1);
 const executor=(id:string,planner=false)=>({id,agent:id.startsWith('claude')?'claude-code':'codex',account:id.split('#')[1]??'codex',host:null,model:null,rank:planner?'planner':1,enabled:true,state:'ready',slots:{used:0,max:1},lastCheck:null});
 const state={...initialState(),connected:true,invalidations:{runners:tick},snapshot:{at:tick,executors:[executor('claude-code',true),...settings.order.map(id=>executor(id))]}} as any;
 return <TaskContext.Provider value={{state,api}}><ActionContext.Provider value={actions}><SettingsPageContext.Provider value="executors"><ExecutorsSection/></SettingsPageContext.Provider></ActionContext.Provider></TaskContext.Provider>;
}
render(<NotificationProvider><App/></NotificationProvider>,document.getElementById('app')!);
