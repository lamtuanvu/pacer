import {render} from 'preact';
import {useState} from 'preact/hooks';
import {Workspace} from '../../app/src/screens/workspace/Workspace';
import {TaskContext} from '../../app/src/screens/task-shared';
import {FrameContext} from '../../app/src/shell/slots';
import {initialState} from '../../app/src/data/store';
import fixture from './ui/task-get.json';
const mode=new URLSearchParams(location.search).get('mode');
const calls:string[]=[];(window as any).workspaceCalls=calls;
const task={...fixture,id:'workspace-task',title:'Inspect workspace session',goal:'Inspect workspace session',state:'running',executor:'codex',updatedAt:Date.now()/1000,progress:{phase:'working'},review:null,reviewRequest:null,worktree:'/tmp/disposable-worktree'};
if(mode==='counts')task.attempts=[{executor:'codex',startedAt:Date.now()/1000-60,endedAt:Date.now()/1000-30,log:''},{executor:'codex',startedAt:Date.now()/1000-20,log:''}] as any;
const info={host:'builtin',live:true,driving:mode==='driving',takeover:{available:mode==='starting'},attempt:1,cols:80,rows:24,controller:null,viewers:0,capabilities:{control:true,resize:true},attach:{ws:'/session'}};
const tasks=Array.from({length:mode==='counts'?20:1},(_,i)=>({...task,id:i?`workspace-task-${i}`:task.id,title:i?`Workspace task ${i}`:task.title}));
const state={...initialState(),connected:true,snapshot:{tasks,attention:[],repos:[]},features:{...initialState().features,ops:new Set(['task.get','task.session','terminal.list','dispatch.list'])}} as any;
const api={call:async(op:string,params:any)=>{calls.push(op);if(op==='task.get')return {...task,...tasks.find(t=>t.id===params.id)};if(op==='task.list')return {tasks};if(op==='dispatch.list')return {tasks:[]};if(op==='dispatch.tree')return {nodes:[],totals:{}};if(op==='terminal.list')return [];if(op==='task.session')return info;if(op==='task.log')return {stdout:'Latest output',stderr:''};if(op==='task.takeover')throw Error('Duplicate takeover');return {};}} as any;
function App(){const [revision,setRevision]=useState(0);(window as any).workspaceFinish=()=>{tasks[0]={...tasks[0]!,state:'done',rev:(tasks[0]!.rev??0)+1};setRevision(n=>n+1);};(window as any).workspaceTick=(changed=false)=>{if(changed)tasks[0]={...tasks[0]!,rev:(tasks[0]!.rev??0)+1};setRevision(n=>n+1);};const [title,setTitle]=useState<HTMLElement|null>(null),[actions,setActions]=useState<HTMLElement|null>(null),[left,setLeft]=useState<HTMLElement|null>(null),[right,setRight]=useState<HTMLElement|null>(null);return <TaskContext.Provider value={{state:{...state,snapshot:{...state.snapshot,seq:revision}},api}}><FrameContext.Provider value={{title,actions,left,right,inline:false,heading(){}}}><header><div ref={setTitle}/><div ref={setActions}/></header><aside ref={setLeft}/><Workspace id={task.id} query={{repo:null,scope:null}}/><aside ref={setRight}/></FrameContext.Provider></TaskContext.Provider>;}
render(<App/>,document.getElementById('app')!);
