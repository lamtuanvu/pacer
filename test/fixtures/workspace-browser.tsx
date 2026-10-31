import {render} from 'preact';
import {useState} from 'preact/hooks';
import {NARROW_MEDIA,PANEL_MEDIA,useMedia} from '../../app/src/shell/narrow';
import {Rail} from '../../app/src/shell/Rail';
import {AppFrame} from '../../app/src/shell/AppFrame';
import {SidePanel} from '../../app/src/ds/SidePanel';
import {CommandTrigger} from '../../app/src/shell/CommandTrigger';
import snapshot from './ui/snapshot.json';
import {TopBar} from '../../app/src/shell/TopBar';
import {Workspace} from '../../app/src/screens/workspace/Workspace';
import {TaskContext} from '../../app/src/screens/task-shared';
import {FrameContext} from '../../app/src/shell/slots';
import {ActionContext} from '../../app/src/data/action-context';
import {createActionRunner} from '../../app/src/data/actions';
import {initialState} from '../../app/src/data/store';
import fixture from './ui/task-get.json';
const mode=new URLSearchParams(location.search).get('mode');
const fullHeader=new URLSearchParams(location.search).has('header');
const paramsLog:any[]=[];(window as any).workspaceParams=paramsLog;
const calls:string[]=[];(window as any).workspaceCalls=calls;
const task={...fixture,question:null as {text:string;at:number;answer?:string}|null,id:'workspace-task',title:'Inspect workspace session',goal:'Inspect workspace session',state:'running',executor:'codex',updatedAt:Date.now()/1000,progress:{phase:'working'},review:null,reviewRequest:null,worktree:'/tmp/disposable-worktree'};
if(mode==='queued')Object.assign(task,{state:'queued',executor:null,attempts:[],worktree:null,startedAt:null,queue:{reason:'paused'},derived:{files:'ready'}});
if(mode==='stopped')Object.assign(task,{state:'stopped',attempts:[],summary:null,acceptance:{state:'none'},derived:{files:'unavailable'}});
if(mode==='failedretry')Object.assign(task,{state:'failed',review:null,acceptance:{state:'failed',cmd:'bun test',tail:'Check failed'}});
if(mode==='managedquestion')Object.assign(task,{state:'needs_input',work:{rootId:'workspace-task',parentId:null,depth:0},question:{text:'Which repository branch should I use?',at:1}});
if(mode==='question')Object.assign(task,{state:'needs_input',question:{text:'Which repository branch should I use?',at:1}});
if(mode==='longnotes')task.brief={...task.brief,goal:Array.from({length:80},(_,i)=>`Requirement ${i+1}: retain session identity and output.`).join('\n')};
if(mode==='longidentity'||mode==='accepted')task.title=task.goal='Split the budget store into read and write paths with a long session identity';
if(mode==='accepted'){task.state='done';task.review={accepted:true,at:Date.now()/1000} as any;}
if(mode==='counts')task.attempts=[{executor:'codex',startedAt:Date.now()/1000-60,endedAt:Date.now()/1000-30,log:''},{executor:'codex',startedAt:Date.now()/1000-20,log:''}] as any;
const info={host:'builtin',live:true,driving:mode==='driving',takeover:{available:mode==='starting'},attempt:1,cols:80,rows:24,controller:null,viewers:0,capabilities:{control:true,resize:true},attach:{ws:'/session'}};
if(mode==='accepted')info.live=false;
if(mode==='ended') { task.state='done'; info.live=false; task.branch='' ; }
if(mode==='headless') {info.host='none';info.live=false;info.takeover.available=true;}
let failSession=mode==='loaderror';
(window as any).workspaceRecover=()=>{failSession=false;};
const tasks=Array.from({length:mode==='counts'?20:1},(_,i)=>({...task,id:i?`workspace-task-${i}`:task.id,title:i?`Workspace task ${i}`:task.title}));
if(mode==='childfile'||mode==='childstates'){tasks[0]={...tasks[0]!,executor:null} as any;tasks.push({...task,id:'workspace-child',title:'Child session',...(mode==='childstates'?{state:'needs_input',question:{text:'Child question?',at:1}}:{})});}
const agentSessions:any[]=[];
function agentCall(op:string,params:any) {
 if(op==='session.agent.list')return agentSessions.map(s=>({...s}));
 if(op==='session.agent.create'){
  const s={id:`00000000-0000-4000-8000-${String(agentSessions.length+1).padStart(12,'0')}`,task_id:task.id,ordinal:agentSessions.length+1,executor:params.executor,request:params.request,cwd:task.worktree,createdAt:Date.now()/1000,rev:1,attempt:1,state:'running',live:true,nativeId:`native-${agentSessions.length+1}`,cols:80,rows:24,attach:{ws:`/agent-${agentSessions.length+1}`}};
  agentSessions.push(s);return {...s};
 }
 if(op==='session.agent.get')return {...agentSessions.find(s=>s.id===params.id)};
 if(op.startsWith('session.agent.')){
  const s=agentSessions.find(s=>s.id===params.id);if(s.rev!==params.expect_rev)throw Error('Session changed');
  s.rev++;s.live=!op.endsWith('.end');s.state=s.live?'running':'ended';if(s.live)s.attempt++;
  return {...s};
 }
}
const state={...initialState(),connected:true,snapshot:{tasks,attention:[],repos:[]},features:{...initialState().features,ops:new Set(['task.get','task.session','terminal.list','dispatch.list','task.review'])}} as any;
const api={call:async(op:string,params:any)=>{
 calls.push(op);paramsLog.push({op,params});
 if(op.startsWith('session.agent.'))return agentCall(op,params);
 if(op==='session.prepare')return {executors:[{id:'codex',agent:'codex',available:true}]};
 if(op==='task.get')return {...task,...tasks.find(t=>t.id===params.id)};
 if(op==='task.list')return {tasks};
 if(op==='dispatch.list')return {tasks:['childfile','childstates'].includes(mode??'')?tasks.map((t,n)=>({id:t.id,parentId:n?task.id:null,rootId:task.id,depth:n,title:t.title,state:t.state,executor:t.executor,rev:1})):[]};
 if(op==='dispatch.tree')return {nodes:[],totals:{}};
 if(op==='terminal.list')return [{id:'shell-fixture',cwd:task.worktree,title:'Fixture',live:true,cols:80,rows:24,attach:{ws:'/shell'}}];
 if(op==='task.session'){if(failSession)throw Error(`Session unavailable. Reconnect and try again. (attempt ${calls.filter(op=>op==='task.session').length})`);return info;}
 if(op==='session.file.read')return {path:'src/a.ts',kind:'code',text:'export const a = 1;',size:19,modified:'2026-10-30',line:2};
 if(op==='task.log')return {stdout:'Latest output',stderr:''};
 if(op==='task.answer'){Object.assign(tasks[0]!,{question:{...tasks[0]!.question,answer:params.text},retriedBy:'answer-retry',rev:50});return {task:tasks[0],retry:{id:'answer-retry',state:'queued'}};}
 if(op==='dispatch.answer'){Object.assign(tasks[0]!,{state:'queued',rev:50,question:{...tasks[0]!.question,answer:params.text}});return {task_id:params.id,state:'queued'};}
 if(op==='task.retry_options')return [{id:'codex#other',state:'ready',reason:'available'}];
 if(op==='task.review'){if(mode==='failedretry')return {retry:{id:'retried-task'}};Object.assign(tasks.find(t=>t.id===params.id)!,{review:{accepted:true},rev:200});return {};}
 if(op==='task.takeover')throw Error('Duplicate takeover');
 return {};
}} as any;
const runner=createActionRunner({call:api.call,waitFor:async()=>true,refetch:()=>{},navigate:href=>{location.hash=href;}});
function App(){
 const narrow=useMedia(NARROW_MEDIA),panels=useMedia(PANEL_MEDIA)&&!narrow;
 const [revision,setRevision]=useState(0);
 (window as any).workspaceAgentEvent=(action:string)=>{
  if(action==='create')agentCall('session.agent.create',{executor:'codex',request:'Other client'});
  else {const s=agentSessions.at(-1);if(s){s.live=false;s.state='ended';s.rev++;}}
  state.snapshot.machine={agentSessionsRevision:JSON.stringify(agentSessions.map(s=>[s.id,s.rev,s.live]))};setRevision(n=>n+1);
 };
 (window as any).workspaceChildFinish=()=>{tasks[1]={...tasks[1]!,state:'done',rev:100,summary:'Fresh child summary'} as any;setRevision(n=>n+1);};
 (window as any).workspaceStart=()=>{tasks[0]={...tasks[0]!,state:'running',executor:'codex',rev:(tasks[0]!.rev??0)+1};setRevision(n=>n+1);};
 (window as any).workspaceFinish=()=>{tasks[0]={...tasks[0]!,state:'done',rev:(tasks[0]!.rev??0)+1};setRevision(n=>n+1);};
 (window as any).workspaceTick=(changed=false)=>{if(changed)tasks[0]={...tasks[0]!,rev:(tasks[0]!.rev??0)+1};setRevision(n=>n+1);};
 const [title,setTitle]=useState<HTMLElement|null>(null),[actions,setActions]=useState<HTMLElement|null>(null),[left,setLeft]=useState<HTMLElement|null>(null),[right,setRight]=useState<HTMLElement|null>(null);
 return <TaskContext.Provider value={{state:{...state,snapshot:{...state.snapshot,seq:revision}},api}}><ActionContext.Provider value={runner}><FrameContext.Provider value={{title,actions,left,right,inline:!panels,heading(){}}}><AppFrame narrow={narrow} activity={<Rail narrow={narrow} route={{name:"terminal",query:{repo:null,scope:null}} as any} counts={null}/>} top={<TopBar narrow={narrow} title="Workspace" planner={fullHeader?snapshot.planner as any:null} mode="normal" connected lastUpdate={null} onDelegate={()=>{}} context={setTitle} actions={setActions} search={fullHeader?<CommandTrigger onOpen={()=>{}}/>:<span>Search fixture</span>} narrowSearch={fullHeader?<CommandTrigger narrow onOpen={()=>{}}/>:<button aria-label="Search">Search</button>}/>} left={panels&&<SidePanel side="left" label="Workspace" open onToggle={()=>{}} bar={false} resize={{key:'fixture-left',initial:272,min:200,max:480}}><div ref={setLeft}/></SidePanel>} right={panels&&<SidePanel side="right" label="Task" open onToggle={()=>{}} bar={false} resize={{key:'fixture-right',initial:320,min:260,max:560}}><div ref={setRight}/></SidePanel>} status={<footer className="pc-statusbar">Fixture status</footer>} overlay={<span className="pc-aurora-launcher"/>} mainClass="pc-main pc-main--canvas pc-main--workbench" main={<Workspace id={mode==='noid'?undefined:task.id} query={{repo:new URLSearchParams(location.hash.split('?')[1]).get('repo'),scope:new URLSearchParams(location.hash.split('?')[1]).get('scope') as any}}/>}/></FrameContext.Provider></ActionContext.Provider></TaskContext.Provider>;
}
render(<App/>,document.getElementById('app')!);
