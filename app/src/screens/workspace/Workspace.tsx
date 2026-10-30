import { useEffect, useRef, useState } from 'preact/hooks';
import type { TaskDetail } from '../../../../src/core/task-detail';
import type { ClientTask as ApiTask } from '../../../../src/view-model/snapshot';
import type { SessionInfo } from '../../../../src/session/service';
import type { SessionFileResult } from '../../../../src/session/files';
import type { TerminalRecord } from '../../../../src/terminal/workspace';
import { markAgent } from '../../../../src/view-model/agents';
import { executorLabel, taskPageStatus as taskStatus } from '../../../../src/view-model/words';
import { AgentMark } from '../../ds/AgentMark';
import { Icon } from '../../ds/icons';
import { Button, IconButton } from '../../ds/Button';
import { Dialog } from '../../ds/Dialog';
import { Disclosure, Field, TextArea, TextInput } from '../../ds/Controls';
import { Tabs, Skeleton, EmptyState } from '../../ds/Patterns';
import { Pill } from '../../ds/Pill';
import { Tooltip } from '../../ds/Tooltip';
import { useDialogs } from '../../ds/useDialogs';
import { AppLink, AppButtonLink } from '../../navigation';
import { hrefFor, routes, type RouteQuery } from '../../router';
import { FrameContext, FrameSlot, useFrame, useFrameHeading } from '../../shell/slots';
import { LazyTerminal } from '../../term/LazyTerminal';
import type { TerminalActions } from '../../term/term';
import { ErrorMessage, useAction, useQuery, useTaskContext } from '../task-shared';
import { FileViewer } from '../session/FileViewer';
import { PlainLog } from '../session/PlainLog';
import { takeoverSession } from '../session/takeover';
import { Diff } from '../review/Diff';
import { NowCard, CostTiles, Acceptance } from '../trace/Overview';
import { hasTaskExecution, traceSteps, tokenValue, type TraceTree } from '../trace/model';
import { changeConversation } from '../../model/conversation';
import { needsYou } from '../../../../src/view-model/selectors';
import { taskTree, workTasks, type TaskNodeView, type WorkRow } from '../../../../src/view-model/task-tree';
import { NewAgentSession } from './NewAgentSession';
import { TaskActions } from '../trace/TaskActions';
import { machineWaitWords } from '../../../../src/view-model/capacity';

interface Panel { id:string; task:string; kind:'session'|'shell'|'file'|'diff'|'attempt'; title:string; shell?:TerminalRecord; file?:SessionFileResult; reference?:string; attempt?:number }
export function workspaceTasks(tasks:ApiTask[], now:number, selected?:string) {
 return tasks.filter(t=>t.id===selected||['running','queued','needs_input'].includes(t.state)||!!t.reviewRequest&&!t.review&&!t.dismissed||t.updatedAt>=now-86400);
}
export function workspaceTaskNodes(tasks:ApiTask[], work:WorkRow[], attention:import('../../../../src/attention/types').AttentionItem[]|undefined, now:number) {
 return taskTree({tasks,attention},{now,extra:workTasks(work)});
}
export function Workspace({id,panel,query}:{id?:string;panel?:string;query:RouteQuery}) {
 const {state,api}=useTaskContext(),frame=useFrame(),dialogs=useDialogs();
 const history=useQuery<{tasks:ApiTask[]}>('task.list',{all:true,limit:100,...(query.repo?{repo:query.repo}:{})});
 const work=useQuery<{tasks:import('../../../../src/view-model/task-tree').WorkRow[]}>('dispatch.list',{relation:'all',limit:100});
 const tasks=[...new Map([...(history.data?.tasks??[]),...(state.snapshot?.tasks??[])].map(t=>[t.id,t])).values()];
 const visible=workspaceTasks(tasks,Date.now()/1000,id).filter(t=>!work.data?.tasks.find(w=>w.id===t.id)?.parentId);
 const membersFor=(task:ApiTask)=>tasks.filter(t=>t.id!==task.id&&work.data?.tasks.find(w=>w.id===t.id)?.rootId===task.id);
 const [selected,setSelected]=useState(id??visible[0]?.id),[expanded,setExpanded]=useState<Record<string,boolean>>(id?{[id]:true}:{});
 const [panels,setPanels]=useState<Panel[]>([]),[active,setActive]=useState(''),[right,setRight]=useState(panel==='changes'?'changes':panel==='notes'?'notes':'overview');
 const [agentPrompt,setAgentPrompt]=useState(false),[menu,setMenu]=useState(false),[filePrompt,setFilePrompt]=useState(false),[path,setPath]=useState(''),[error,setError]=useState<unknown>(),[busy,setBusy]=useState(false);
 const shells=useQuery<TerminalRecord[]>('terminal.list',{});
 const detail=useQuery<TaskDetail>('task.get',{id:selected??''},'',false,!!selected);
 const selectedTree=useQuery<TraceTree>('dispatch.tree',{id:selected??''},'',false,!!selected);
 const details=useRef(new Map<string,TaskDetail>());
 if(detail.data)details.current.set(detail.data.id,detail.data);
 const current=panels.find(p=>p.id===active),t=detail.data;
 const open=(p:Panel)=>{setPanels(previous=>previous.some(x=>x.id===p.id)?previous:[...previous,p]);setActive(p.id);setMenu(false);};
 const sessionPanel=(task:ApiTask)=>{const members=membersFor(task);const member=task.executor?task:members.find(t=>t.executor&&['running','queued','needs_input'].includes(t.state))??members.find(t=>t.executor)??task;open({id:`session:${member.id}`,task:member.id,kind:'session',title:'Task workspace'});};
 useEffect(()=>{if(id){setSelected(id);setExpanded(p=>({...p,[id]:true}));sessionPanel(tasks.find(t=>t.id===id)??{id,executor:null} as ApiTask);}},[id]);
 const initialPanelOpened=useRef(false);
 useEffect(()=>{if(!id&&!initialPanelOpened.current){const first=visible.find(t=>t.id===selected)??visible[0];if(first){initialPanelOpened.current=true;setSelected(first.id);setExpanded({[first.id]:true});sessionPanel(first);}}},[id,selected,visible[0]?.id]);
 useEffect(()=>{if(panel==='changes'||panel==='notes')setRight(panel);},[panel]);
 const close=(p:Panel)=>{setPanels(old=>old.filter(x=>x.id!==p.id));if(active===p.id)setActive(panels.filter(x=>x.id!==p.id).at(-1)?.id??'');};
 const openFile=async(reference:string,taskId=selected)=>{
  if(!taskId)return;setBusy(true);setError(undefined);
  try{const session=await api.call<SessionInfo>('task.session',{id:taskId});if(!session.attempt)throw new Error('File preview requires a recorded session attempt.');const file=await api.call<SessionFileResult>('session.file.read',{id:taskId,attempt:session.attempt,reference});open({id:`file:${taskId}:${file.path}`,task:taskId,kind:'file',title:file.path.split('/').at(-1)!,file,reference});setFilePrompt(false);}catch(e){setError(e);}finally{setBusy(false);}
 };
 const appliedPanel=useRef('');
 useEffect(()=>{
  const key=`${id??''}:${panel??''}`;
  if(!panel||['overview','notes','changes','session'].includes(panel)||appliedPanel.current===key)return;
  const existing=panels.find(p=>p.id===panel);
  if(existing){setActive(existing.id);appliedPanel.current=key;return;}
  const shell=shells.data?.find(s=>s.id===panel||`shell:${s.id}`===panel);
  if(shell){open({id:shell.id,task:selected??'',kind:'shell',title:`Your shell · ${shell.title}`,shell});appliedPanel.current=key;return;}
  if(id&&panel.startsWith(`diff:${id}:`)){const reference=panel.slice(`diff:${id}:`.length);open({id:panel,task:id,kind:'diff',title:reference.split('/').at(-1)!,reference});appliedPanel.current=key;}
  if(id&&panel.startsWith(`file:${id}:`)){appliedPanel.current=key;void openFile(panel.slice(`file:${id}:`.length),id);}
 },[id,panel,shells.data,panels.length]);
 const shellFor=(task:ApiTask,s:TerminalRecord)=>s.cwd===task.worktree||s.cwd===task.repo?.path;
 const newShell=async()=>{setBusy(true);try{const shell=await api.call<TerminalRecord>('terminal.create',{request_id:crypto.randomUUID(),kind:'shell',...(t?.worktree||t?.repo.path?{cwd:t.worktree??t.repo.path}:{})});shells.reload();open({id:shell.id,task:selected??'',kind:'shell',title:`Your shell · ${shell.title}`,shell});}catch(e){setError(e);}finally{setBusy(false);}};
 // There is no operation for adding a second interactive agent to an existing task.
 // Preserve the selected task's brief/worktree in the closest supported launch flow.
 const newAgent=()=>{setMenu(false);setAgentPrompt(true);};
 useFrameHeading(null);
 const cardNodes=workspaceTaskNodes(tasks,work.data?.tasks??[],state.snapshot?needsYou(state.snapshot,{repo:query.repo}):undefined,Date.now()/1000);
 const left=<div className="pc-workspace-list"><div className="pc-workspace-list__head"><b>Workspace</b><AppLink to={routes.tasks(query)}>All tasks</AppLink></div><ErrorMessage error={history.error}/>{visible.map(task=><WorkspaceCard key={task.id} task={task} activePanel={active} node={cardNodes.find(n=>n.id===task.id)!} detail={details.current.get(task.id)} tokens={work.data?.tasks.find(w=>w.id===task.id)?.tokens} members={membersFor(task)} selected={selected===task.id||membersFor(task).some(t=>t.id===selected)} expanded={!!expanded[task.id]} shells={(shells.data??[]).filter(s=>shellFor(task,s))} onSelect={()=>{setSelected(task.id);setRight('overview');sessionPanel(task);}} onToggle={()=>setExpanded(p=>({...p,[task.id]:!p[task.id]}))} onSession={sessionPanel} onShell={s=>open({id:s.id,task:task.id,kind:'shell',title:`Your shell · ${s.title}`,shell:s})} onAttempt={(n,label)=>{setSelected(task.id);open({id:`attempt:${task.id}:${n}`,task:task.id,kind:'attempt',attempt:n,title:label});}}/>)}</div>;
 const rightPanel=<div className="pc-workspace-task"><Tabs id="workspace-task" label="Task details" value={right} onChange={setRight} options={[{value:'overview',label:'Overview'},{value:'changes',label:'Changes'},{value:'notes',label:'Notes'}]}/><ErrorMessage error={detail.error}/>{t?<><div className="pc-workspace-task__title"><AppLink to={routes.task(t.id)}>{t.title??t.goal}</AppLink><span className="pc-trace__cap">{t.repo.label} · {t.branch}</span></div><div className="pc-workspace-task__body" role="tabpanel" id={`workspace-task-${right}-panel`} aria-labelledby={`workspace-task-${right}-tab`}>
 {right==='overview'?<><CostTiles task={t} tokens={selectedTree.data?.totals.tokens??t.tokens} agentsUsed={selectedTree.data?.nodes.some(n=>n.attempts.length)?new Set(selectedTree.data.nodes.flatMap(n=>n.attempts.map(a=>markAgent(a.executor)))).size:undefined} compact/><Disclosure summary="Recent decisions"><RecentDecisions task={t} tree={selectedTree.data}/></Disclosure>{['running','needs_input'].includes(t.state)&&<Acceptance task={t} compact/>}<AppButtonLink to={routes.task(t.id)}>Task history</AppButtonLink></>:right==='changes'?<>{hasTaskExecution(t)&&t.files.map(f=><Button key={f.path} variant="quiet" className="pc-workspace-file" title={f.path} onClick={()=>open({id:`diff:${t.id}:${f.path}`,task:t.id,kind:'diff',title:f.path.split('/').at(-1)!,reference:f.path})}><span>{f.path}</span><span className="pc-trace__good">+{f.added}</span><span>−{f.removed}</span></Button>)}{(!hasTaskExecution(t)||!t.files.length)&&<p className="pc-trace__cap">{!hasTaskExecution(t)?'No task changes yet. Changes appear after this task starts.':t.derived?.files==='unavailable'?'Changes unavailable. The worktree could not be read.':'No changed files recorded.'}</p>}</>:<><section><h2>Brief</h2><p>{t.brief.goal}</p>{t.brief.constraints&&<p>{t.brief.constraints}</p>}</section><section><h2>Summary</h2><p>{t.summary??'No summary recorded.'}</p></section></>}
 </div></>:(selected?!detail.error&&<Skeleton layout="rows" label="Loading the task"/>:<EmptyState title="Select a task" description="Choose a task on the left to see its details."/>)}</div>;
 return <div className="pc-workspace"><FrameSlot name="left">{left}</FrameSlot><FrameSlot name="right">{rightPanel}</FrameSlot>{frame?.inline&&<>{left}</>}{dialogs.dialog}{agentPrompt&&t&&<Dialog title="New agent session" close={()=>setAgentPrompt(false)}><NewAgentSession task={t}/></Dialog>}
 <div className="pc-workspace-center"><div className="pc-workspace-panels"><Tabs id="workspace-panels" label="Workspace panels" value={active} onChange={setActive} options={panels.map(p=>({value:p.id,label:p.title,buttonProps:{title:p.title},trailing:<IconButton size="sm" variant="quiet" aria-label={`Close ${p.title}`} title={`Close ${p.title}`} onClick={()=>close(p)}>×</IconButton>}))}/><div className="pc-terminal-menu-anchor"><IconButton icon="plus" size="sm" variant="quiet" aria-label="New panel" title="New panel" aria-expanded={menu} onClick={()=>setMenu(!menu)}/>{menu&&<div className="pc-terminal-menu" role="menu"><Button role="menuitem" onClick={()=>void newShell()}>New shell in this worktree</Button>{t&&<Button role="menuitem" onClick={newAgent}>New agent session on this task…</Button>}<Button role="menuitem" onClick={()=>{setMenu(false);setFilePrompt(true);}}>Open a file…</Button></div>}</div></div>
 <ErrorMessage error={error}/>{panels.map(p=><FrameContext.Provider key={p.id} value={active===p.id?frame:frame?{...frame,title:null,actions:null}:null}><div hidden={active!==p.id} className="pc-workspace-content" role="tabpanel" id={`workspace-panels-${p.id}-panel`} aria-labelledby={`workspace-panels-${p.id}-tab`}>
 {p.kind==='session'?<AgentPanel id={p.task} detail={details.current.get(p.task)} work={!!work.data?.tasks.some(w=>w.id===p.task)} openFile={reference=>void openFile(reference,p.task)} selected={selected===p.task} reload={detail.reload} query={query}/>:p.kind==='shell'&&p.shell?<ShellPanel panel={p}/>:p.kind==='file'?<FilePanel panel={p} detail={details.current.get(p.task)} close={()=>close(p)} refresh={()=>void openFile(p.reference!,p.task)} openFile={r=>void openFile(r,p.task)}/>:p.kind==='diff'?<DiffPanel panel={p}/>:<AttemptPanel panel={p} task={details.current.get(p.task)}/>}</div></FrameContext.Provider>)}{!current&&<EmptyState title="Open a session, shell or file" description="Select a session on the left, or use + to open a panel."/>}
 </div>{frame?.inline&&rightPanel}{filePrompt&&<Dialog title="Open a file" close={()=>setFilePrompt(false)}><form className="pc-form" onSubmit={e=>{e.preventDefault();void openFile(path);}}><Field label="Path in this task’s worktree"><TextInput autoFocus required value={path} onInput={e=>setPath(e.currentTarget.value)}/></Field><Button type="submit" busy={busy}>Open file</Button><ErrorMessage error={error}/></form></Dialog>}</div>;
}
function WorkspaceCard({task,activePanel,node,detail,tokens,members,selected,expanded,shells,onSelect,onToggle,onSession,onShell,onAttempt}:{task:ApiTask;activePanel:string;node:TaskNodeView;detail?:TaskDetail;tokens?:import('../../../../src/view-model/task-tree').TreeTokens|null;members:ApiTask[];selected:boolean;expanded:boolean;shells:TerminalRecord[];onSelect:()=>void;onToggle:()=>void;onSession:(task:ApiTask)=>void;onShell:(s:TerminalRecord)=>void;onAttempt:(n:number,label:string)=>void}) {
 const title=node.title,tone=node.attention!=='none'?node.attention:node.state.tone,status=node.attentionLabel??node.state.label,attempts=detail?.attempts??[];
 const sessions=[...(members.length?members:task.executor?[task]:[]).map(member=>({id:`session:${member.id}`,name:executorLabel(member.executor),agent:markAgent(member.executor??'unknown'),state:member.state==='running'?'Live':member.state==='needs_input'?'Needs input':member.state==='queued'?'Waiting':'Ended',shell:false,open:()=>onSession(member)})),...shells.map(s=>({id:s.id,name:`Your shell · ${s.title}`,state:s.live?'Idle':'Ended',agent:'shell',shell:true,open:()=>onShell(s)})),...attempts.slice(0,-1).map((a,n)=>({id:`attempt:${task.id}:${n}`,name:`Attempt ${n+1} · ${executorLabel(a.executor)}`,state:'Ended',agent:markAgent(a.executor),shell:false,open:()=>onAttempt(n,`Attempt ${n+1}`)}))];
 const toggle=<Button className="pc-workspace-session-toggle" variant="quiet" size="sm" aria-label={`${expanded?'Collapse':'Expand'} sessions for ${title}`} aria-expanded={expanded} onClick={onToggle}><span>{sessions.length} {sessions.length===1?'session':'sessions'}</span><Icon name="chevron-down"/></Button>;
 return <article className={`pc-workspace-card pc-workspace-card--${tone}${selected?' pc-workspace-card--selected':''}`}>
 <Button className="pc-workspace-card__select" variant="quiet" aria-label={`Select task: ${title}`} aria-pressed={selected} onClick={onSelect}>
 <span className="pc-workspace-card__heading"><span aria-hidden="true" className={`pc-workspace-dot pc-workspace-dot--${tone}${node.state.live?' pc-status-dot__dot--live':''}`}/><span className="pc-workspace-card__title" title={title}>{title}</span></span>
 <span className="pc-workspace-card__meta"><span className="pc-workspace-host">{task.host??'This Mac'}</span><span className="pc-workspace-repo" title={task.repo?.label}>{task.repo?.label}</span></span>
 <span className="pc-workspace-card__meta"><span className={`pc-workspace-card__status pc-workspace-card__status--${tone}`}>{status}</span><span>{node.tokens?.replace(/ tokens$/,'')??tokenValue(tokens??detail?.tokens)}</span></span>
 </Button>
 <div className={`pc-workspace-card__sessions${expanded?' pc-workspace-card__sessions--expanded':''}`}><div className="pc-workspace-card__session-head">{expanded?<span className="grow">Sessions</span>:<span className="pc-workspace-session-icons">{sessions.map(s=><Tooltip key={s.id} text={`${s.name} · ${s.state}`}><IconButton className="pc-workspace-session-icon" size="sm" variant="quiet" aria-label={`${s.name} · ${s.state}`} onClick={s.open}>{s.shell?<span aria-hidden="true">⌘</span>:<AgentMark agent={s.agent} size={16}/>}<span aria-hidden="true" className={`pc-workspace-dot pc-workspace-dot--${s.state==='Live'?'info':'neutral'}${s.state==='Live'?' pc-status-dot__dot--live':''}`}/></IconButton></Tooltip>)}</span>}{toggle}</div>{expanded&&<div className="pc-workspace-session-rows">{sessions.map(s=><Button key={s.id} className={`pc-workspace-session-row${activePanel===s.id?' pc-workspace-session-row--selected':''}`} aria-pressed={activePanel===s.id} variant="quiet" onClick={s.open}>{s.shell?<span aria-hidden="true">⌘</span>:<AgentMark agent={s.agent} size={16}/>}<span>{s.name}</span><span aria-hidden="true" className={`pc-workspace-dot pc-workspace-dot--${s.state==='Live'?'info':'neutral'}${s.state==='Live'?' pc-status-dot__dot--live':''}`}/><span>{s.state}</span></Button>)}</div>}</div></article>;
}
function RecentDecisions({task,tree}:{task:TaskDetail;tree?:TraceTree}) {return <section><h2>Recent decisions</h2>{traceSteps(task,tree).slice(-3).map((s,n)=><p key={n} className="pc-trace__cap">✓ {s.title}</p>)}</section>;}
function AgentPanel({id,detail:cachedDetail,work,openFile,selected,reload,query}:{id:string;detail?:TaskDetail;work:boolean;openFile:(r:string)=>void;selected:boolean;reload:()=>void;query:RouteQuery}) {
 const {api,state}=useTaskContext();
 const liveTask=state.snapshot?.tasks.find(task=>task.id===id);
 const [ownRequested,setOwnRequested]=useState(false);
 const cachedCurrent=!!cachedDetail&&(!liveTask||cachedDetail.rev===liveTask.rev&&cachedDetail.state===liveTask.state);
 const ownDetail=useQuery<TaskDetail>('task.get',{id},'',false,!selected&&(ownRequested||!cachedCurrent));
 const retainedDetail=ownDetail.data&&(!cachedDetail||ownDetail.data.rev>=cachedDetail.rev)?ownDetail.data:cachedDetail;
 const detail=selected?cachedDetail:retainedDetail;
 const reloadDetail=selected?reload:()=>{setOwnRequested(true);ownDetail.reload();};
 const task=liveTask??detail;
 const session=useQuery<SessionInfo>('task.session',{id},'',false,!!task&&task.state!=='queued');
 const [wantsControl,setWantsControl]=useState(false),[driving,setDriving]=useState(false),[takeRequested,setTakeRequested]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
 const controls=useRef<TerminalActions|null>(null),dialogs=useDialogs();
 const take=async(initial?:'starting'|'driving')=>{setBusy(true);try{if(!initial&&session.data?.host==='builtin'&&session.data.live){setWantsControl(true);setTakeRequested(true);}else await takeoverSession({id,state:initial,call:api.call.bind(api),starting:()=>{},ready:info=>{session.setData(info);setWantsControl(true);setTakeRequested(true);}});}catch(e){setError(e);}finally{setBusy(false);}};
 useEffect(()=>{const params=new URLSearchParams(location.hash.split('?')[1]);const pending=params.get('takeover');if(pending==='1'&&!session.data)return;if(pending){params.delete('takeover');history.replaceState(null,'',`${location.hash.split('?')[0]}?${params}`);void take(pending==='starting'||pending==='driving'?pending:undefined);}},[id,session.data?.host,session.data?.live]);
 // Opening a workspace is read-only, even when another viewer controls the session.
 const [stoppedAt,setStoppedAt]=useState<string>();
 const taskRevision=JSON.stringify([task?.rev,task?.state]);
 const stopped=stoppedAt===taskRevision;
 const t=stopped&&task?{...task,state:'stopped' as const}:task,s=session.data,live=!!s?.live&&!!t&&['running','queued','needs_input'].includes(t.state);
 const end=async()=>{if(!await dialogs.confirm('Stop this task? The output and changes are kept.','Stop task','Stop task'))return;try{if(t?.interactionMode==='conversation')await changeConversation(api,id,'end');else await api.call(work||detail?.work?'dispatch.stop':'task.stop',{id,expect_rev:t?.rev});setStoppedAt(taskRevision);setWantsControl(false);setDriving(false);session.reload();}catch(e){setError(e);}};
 return <>{dialogs.dialog}<FrameSlot name="title"><div className="pc-workspace-panel-details">{t?.executor&&<AgentMark agent={markAgent(t.executor)} size={18}/>}<div><b>{t?.executor&&`${executorLabel(t.executor)} · `}{t?.title??t?.goal}</b><span>{t?.repo?.label} {detail?.branch&&`· ${detail.branch}`} · {t?.state==='queued'?'Waiting to start':t&&!['running','needs_input'].includes(t.state)?'Task result':driving?"You control this session":'Watching · read-only'}</span></div>{t&&<Pill tone={taskStatus(t).tone}>{taskStatus(t).label}</Pill>}</div></FrameSlot><FrameSlot name="actions">{t&&['running','queued','needs_input'].includes(t.state)&&<>{driving?<IconButton geometry="board" className="pc-workspace-handback" variant="quiet" icon="hand-back" aria-label="Hand back" title="Hand back" onClick={()=>{controls.current?.release();setDriving(false);setWantsControl(false);setTakeRequested(false);}}/>:(s?.takeover.available||s?.host==='builtin'&&live)&&<Button variant="secondary" size="sm" busy={busy} onClick={()=>void take()}>Take control</Button>}<IconButton geometry="board" variant="quiet" tone="bad" icon="stop-session" aria-label="Stop task" title="Stop task" onClick={()=>void end()}/></>}</FrameSlot><ErrorMessage error={error??ownDetail.error??session.error}/>{!t?<Skeleton layout="rows" label="Loading task"/>:t.state==='queued'?<WaitingTask task={t}/>:!['running','needs_input'].includes(t.state)?detail?<WorkspaceResult task={{...detail,state:t.state}} query={query} reload={reloadDetail}/>:<Skeleton layout="rows" label="Loading result"/>:<>{t.state==='needs_input'&&detail&&<WorkspaceQuestion task={{...detail,...t}} query={query} reload={reloadDetail}/>}{!s?<Skeleton layout="rows" label="Loading session"/>:s.host==='builtin'?<LazyTerminal id={id} url={s.attach.ws} cols={s.cols} rows={s.rows} live={live} control={wantsControl} resize={wantsControl} onControlChange={setDriving} takeRequested={takeRequested} onTakeSent={()=>setTakeRequested(false)} onActions={a=>{controls.current=a;}} onOpenFile={openFile}/>:s.host==='orca'?<p>This session runs in Orca. Open workspace output from the original host.</p>:<PlainLog id={id}/>}</>}</>;
}

export function workspaceWait(task:Pick<ApiTask,'queue'>) {
 const q=task.queue;
 const reason=q?.reason==='paused'?'Delegation is paused.':q?.reason==='host_down'?'The execution host is unavailable.':q?.reason==='waiting_retry'?'Waiting to retry the executor start.':q?.reason==='no_slot'?'Waiting for parallel task capacity.':q&&machineWaitWords(q)||'Waiting for an executor to start this task.';
 const next=q?.reason==='paused'?'Resume delegation from Dispatch to let this task start.':q?.reason==='host_down'?'Restore the execution host connection. This workspace will follow the task when it starts.':'Pacer will retry automatically when the executor is available. This workspace will show the session when it starts.';
 return {reason,next};
}
function WaitingTask({task}:{task:ApiTask}) {
 const wait=workspaceWait(task);
 return <section className="pc-workspace-state" aria-label="Waiting to start" aria-live="polite"><h2>Waiting to start</h2><p>{wait.reason}</p><p>{wait.next}</p></section>;
}
function WorkspaceQuestion({task,query,reload}:{task:TaskDetail;query:RouteQuery;reload:()=>void}) {
 const action=useAction(),[text,setText]=useState('');
 const question=task.question,available=question&&question.answer===undefined&&!task.retriedBy;
 return <section className="pc-workspace-state" aria-label="Question"><h2>The agent needs your answer</h2>{question?<p>{question.text}</p>:<p>Read the session output for the question. Take control to answer in the session.</p>}{available&&<><Field label="Your answer"><TextArea value={text} rows={3} maxLength={2000} onInput={e=>setText(e.currentTarget.value)}/></Field><Button variant="primary" busy={action.busy} disabled={!text.trim()} onClick={()=>void action.run<{retry?:{id?:string}}>(task.work?'dispatch.answer':'task.answer',{id:task.id,text:text.trim(),expect_rev:task.rev,...(task.work?{requestId:`${task.id}.${task.rev}.answer`}:{})},result=>{setText('');if(result.retry?.id)location.hash=hrefFor(routes.workspace(result.retry.id),query);else reload();})}>Send answer</Button></>}<ErrorMessage error={action.error}/></section>;
}
function WorkspaceResult({task,query,reload}:{task:TaskDetail;query:RouteQuery;reload:()=>void}) {
 return <section className="pc-workspace-state" aria-label="Task result"><NowCard task={task} compact/>{task.summary&&<section><h2>Result</h2><p>{task.summary}</p></section>}<Acceptance task={task} compact/><TaskActions task={task} query={query} reload={reload} embedded/><p className="pc-trace__cap">Open Changes to inspect files, or Task history for the full report.</p></section>;
}

function ShellPanel({panel:p}:{panel:Panel}) {return <><FrameSlot name="title"><div className="pc-workspace-panel-details"><div><b>Your shell · {p.shell?.title}</b><span>{p.shell?.cwd} · login shell</span></div></div></FrameSlot><LazyTerminal id={p.shell!.id} url={p.shell!.attach.ws} cols={p.shell!.cols} rows={p.shell!.rows} live={p.shell!.live} control resize shell/></>;}
export function workspaceEditorHref(root:string, file:SessionFileResult) {
 const path=`${root}/${file.path}`.split('/').map(encodeURIComponent).join('/');
 return `vscode://file${path}${file.line?`:${file.line}${file.column?`:${file.column}`:''}`:''}`;
}
function FilePanel({panel:p,detail,close,refresh,openFile}:{panel:Panel;detail?:TaskDetail;close:()=>void;refresh:()=>void;openFile:(r:string)=>void}) {
 // A file may belong to a child session while the right panel still shows its root.
 const ownDetail=useQuery<TaskDetail>('task.get',{id:p.task},'',false,!detail);
 const task=detail??ownDetail.data,root=task?.worktree??task?.repo.path;
 const openInEditor=p.file&&root?()=>{location.href=workspaceEditorHref(root,p.file!);}:undefined;
 return <>
  <FrameSlot name="actions">{openInEditor&&<IconButton geometry="board" variant="quiet" icon="external" aria-label="Open in editor" title="Open in editor" onClick={openInEditor}/>}</FrameSlot>
  <FrameSlot name="title"><div className="pc-workspace-panel-details"><div><b>{p.file?.path}</b><span>Read-only · opened from the workspace</span></div></div></FrameSlot>
  <ErrorMessage error={ownDetail.error}/>
  <FileViewer sidePanel file={p.file} reference={p.reference} onClose={close} onRefresh={refresh} onOpenFile={openFile}/>
 </>;
}
function DiffPanel({panel:p}:{panel:Panel}) {const diff=useQuery<{patch:string;truncated:boolean}>('task.diff',{id:p.task,path:p.reference});return <><FrameSlot name="title"><div className="pc-workspace-panel-details"><b>{p.reference} · Changes</b></div></FrameSlot><ErrorMessage error={diff.error}/>{diff.data?<Diff path={p.reference!} patch={diff.data.patch} truncated={diff.data.truncated}/>:<Skeleton layout="rows" label="Loading diff"/>}</>;}
function AttemptPanel({panel:p,task}:{panel:Panel;task?:TaskDetail}) {return <><FrameSlot name="title"><div className="pc-workspace-panel-details"><b>{p.title} · Ended</b></div></FrameSlot><pre className="pc-code-scroll">{task?.attempts[p.attempt??0] ? 'No saved output is available for this earlier attempt.' : 'No attempt recorded.'}</pre></>;}
