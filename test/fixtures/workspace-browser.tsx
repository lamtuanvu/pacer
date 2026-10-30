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
const info={host:'builtin',live:true,driving:mode==='driving',takeover:{available:mode==='starting'},attempt:1,cols:80,rows:24,controller:null,viewers:0,capabilities:{control:true,resize:true},attach:{ws:'/session'}};
const state={...initialState(),connected:true,snapshot:{tasks:[task],attention:[],repos:[]},features:{...initialState().features,ops:new Set(['task.get','task.session','terminal.list','dispatch.list'])}} as any;
const api={call:async(op:string)=>{calls.push(op);if(op==='task.get')return task;if(op==='task.list')return {tasks:[task]};if(op==='dispatch.list')return {tasks:[]};if(op==='dispatch.tree')return {nodes:[],totals:{}};if(op==='terminal.list')return [];if(op==='task.session')return info;if(op==='task.log')return {stdout:'Latest output',stderr:''};if(op==='task.takeover')throw Error('Duplicate takeover');return {};}} as any;
function App(){const [title,setTitle]=useState<HTMLElement|null>(null),[actions,setActions]=useState<HTMLElement|null>(null),[left,setLeft]=useState<HTMLElement|null>(null),[right,setRight]=useState<HTMLElement|null>(null);return <TaskContext.Provider value={{state,api}}><FrameContext.Provider value={{title,actions,left,right,inline:false,heading(){}}}><header><div ref={setTitle}/><div ref={setActions}/></header><aside ref={setLeft}/><Workspace id={task.id} query={{repo:null,scope:null}}/><aside ref={setRight}/></FrameContext.Provider></TaskContext.Provider>;}
render(<App/>,document.getElementById('app')!);
