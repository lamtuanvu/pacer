import { useEffect, useRef, useState } from 'preact/hooks';
import type { TaskDetail } from '../../../../src/core/task-detail';
import type { ClientTask as ApiTask } from '../../../../src/view-model/snapshot';
import type { SessionInfo } from '../../../../src/session/service';
import type { SessionFileResult } from '../../../../src/session/files';
import type { TerminalRecord } from '../../../../src/terminal/workspace';
import { markAgent } from '../../../../src/view-model/agents';
import { executorLabel, taskPageStatus as taskStatus } from '../../../../src/view-model/words';
import { AgentMark } from '../../ds/AgentMark';
import { Button, IconButton } from '../../ds/Button';
import { Dialog } from '../../ds/Dialog';
import { Field, TextInput } from '../../ds/Controls';
import { Tabs, Skeleton, EmptyState } from '../../ds/Patterns';
import { Pill } from '../../ds/Pill';
import { Tooltip } from '../../ds/Tooltip';
import { useDialogs } from '../../ds/useDialogs';
import { AppLink, AppButtonLink } from '../../navigation';
import { routes, type RouteQuery } from '../../router';
import { FrameContext, FrameSlot, useFrame, useFrameHeading } from '../../shell/slots';
import { LazyTerminal } from '../../term/LazyTerminal';
import type { TerminalActions } from '../../term/term';
import { ErrorMessage, useQuery, useTaskContext } from '../task-shared';
import { FileViewer } from '../session/FileViewer';
import { PlainLog } from '../session/PlainLog';
import { takeoverSession } from '../session/takeover';
import { Diff } from '../review/Diff';
import { NowCard, CostTiles, Acceptance } from '../trace/Overview';
import { traceSteps, tokenValue, type TraceTree } from '../trace/model';
import { changeConversation } from '../../model/conversation';
import { NewAgentSession } from './NewAgentSession';

interface Panel { id:string; task:string; kind:'session'|'shell'|'file'|'diff'|'attempt'; title:string; shell?:TerminalRecord; file?:SessionFileResult; reference?:string; attempt?:number }
export function workspaceTasks(tasks:ApiTask[], now:number, selected?:string) {
 return tasks.filter(t=>t.id===selected||['running','queued','needs_input'].includes(t.state)||!!t.reviewRequest&&!t.review&&!t.dismissed||t.updatedAt>=now-86400);
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
 const sessionPanel=(task:ApiTask)=>{const member=task.executor?task:membersFor(task).find(t=>t.executor)??task;open({id:`session:${member.id}`,task:member.id,kind:'session',title:executorLabel(member.executor)});};
 useEffect(()=>{if(id){setSelected(id);setExpanded(p=>({...p,[id]:true}));sessionPanel(tasks.find(t=>t.id===id)??{id,executor:null} as ApiTask);}else if(!panels.length&&visible[0]){const first=visible.find(t=>t.id===selected)??visible[0];setSelected(first.id);setExpanded({[first.id]:true});sessionPanel(first);}},[id,visible[0]?.id]);
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
 const left=<div className="pc-workspace-list"><div className="pc-workspace-list__head"><b>Workspace</b><AppLink to={routes.tasks(query)}>All tasks</AppLink></div><ErrorMessage error={history.error}/>{visible.map(task=><WorkspaceCard key={task.id} task={task} detail={details.current.get(task.id)} tokens={work.data?.tasks.find(w=>w.id===task.id)?.tokens} members={membersFor(task)} selected={selected===task.id||membersFor(task).some(t=>t.id===selected)} expanded={!!expanded[task.id]} shells={(shells.data??[]).filter(s=>shellFor(task,s))} onSelect={()=>{setSelected(task.id);setExpanded(p=>({...p,[task.id]:true}));}} onToggle={()=>setExpanded(p=>({...p,[task.id]:!p[task.id]}))} onSession={sessionPanel} onShell={s=>open({id:s.id,task:task.id,kind:'shell',title:`Your shell · ${s.title}`,shell:s})} onAttempt={(n,label)=>{setSelected(task.id);open({id:`attempt:${task.id}:${n}`,task:task.id,kind:'attempt',attempt:n,title:label});}}/>)}</div>;
 const rightPanel=<div className="pc-workspace-task"><Tabs id="workspace-task" label="Task details" value={right} onChange={setRight} options={[{value:'overview',label:'Overview'},{value:'changes',label:'Changes'},{value:'notes',label:'Notes'}]}/><ErrorMessage error={detail.error}/>{t?<><div className="pc-workspace-task__title"><AppLink to={routes.task(t.id)}>{t.title??t.goal}</AppLink><span className="pc-trace__cap">{t.repo.label} · {t.branch}</span></div><div className="pc-workspace-task__body" role="tabpanel" id={`workspace-task-${right}-panel`} aria-labelledby={`workspace-task-${right}-tab`}>
 {right==='overview'?<><NowCard task={t} compact/><CostTiles task={t} tokens={selectedTree.data?.totals.tokens??t.tokens} agentsUsed={selectedTree.data?new Set(selectedTree.data.nodes.flatMap(n=>n.attempts.map(a=>markAgent(a.executor)))).size:undefined} compact/><RecentDecisions task={t} tree={selectedTree.data}/><Acceptance task={t} compact/><AppButtonLink to={routes.task(t.id)}>Open task page</AppButtonLink></>:right==='changes'?<>{t.files.map(f=><Button key={f.path} variant="quiet" className="pc-workspace-file" title={f.path} onClick={()=>open({id:`diff:${t.id}:${f.path}`,task:t.id,kind:'diff',title:f.path.split('/').at(-1)!,reference:f.path})}><span>{f.path}</span><span className="pc-trace__good">+{f.added}</span><span>−{f.removed}</span></Button>)}{!t.files.length&&<p className="pc-trace__cap">No changed files recorded.</p>}</>:<><section><h2>Brief</h2><p>{t.brief.goal}</p>{t.brief.constraints&&<p>{t.brief.constraints}</p>}</section><section><h2>Summary</h2><p>{t.summary??'No summary recorded.'}</p></section></>}
 </div></>:(selected?!detail.error&&<Skeleton layout="rows" label="Loading the task"/>:<EmptyState title="Select a task" description="Choose a task on the left to see its details."/>)}</div>;
 return <div className="pc-workspace"><FrameSlot name="left">{left}</FrameSlot><FrameSlot name="right">{rightPanel}</FrameSlot>{frame?.inline&&<>{left}</>}{dialogs.dialog}{agentPrompt&&t&&<Dialog title="New agent session" close={()=>setAgentPrompt(false)}><NewAgentSession task={t}/></Dialog>}
 <div className="pc-workspace-center"><div className="pc-workspace-panels"><Tabs id="workspace-panels" label="Workspace panels" value={active} onChange={setActive} options={panels.map(p=>({value:p.id,label:p.title,buttonProps:{title:p.title},trailing:<IconButton size="sm" variant="quiet" aria-label={`Close ${p.title}`} title={`Close ${p.title}`} onClick={()=>close(p)}>×</IconButton>}))}/><div className="pc-terminal-menu-anchor"><IconButton icon="plus" size="sm" variant="quiet" aria-label="New panel" title="New panel" aria-expanded={menu} onClick={()=>setMenu(!menu)}/>{menu&&<div className="pc-terminal-menu" role="menu"><Button role="menuitem" onClick={()=>void newShell()}>New shell in this worktree</Button>{t&&<Button role="menuitem" onClick={newAgent}>New agent session on this task…</Button>}<Button role="menuitem" onClick={()=>{setMenu(false);setFilePrompt(true);}}>Open a file…</Button></div>}</div></div>
 <ErrorMessage error={error}/>{panels.map(p=><FrameContext.Provider key={p.id} value={active===p.id?frame:frame?{...frame,title:null,actions:null}:null}><div hidden={active!==p.id} className="pc-workspace-content" role="tabpanel" id={`workspace-panels-${p.id}-panel`} aria-labelledby={`workspace-panels-${p.id}-tab`}>
 {p.kind==='session'?<AgentPanel id={p.task} detail={details.current.get(p.task)} work={!!work.data?.tasks.some(w=>w.id===p.task)} openFile={reference=>void openFile(reference,p.task)}/>:p.kind==='shell'&&p.shell?<ShellPanel panel={p}/>:p.kind==='file'?<FilePanel panel={p} close={()=>close(p)} refresh={()=>void openFile(p.reference!,p.task)} openFile={r=>void openFile(r,p.task)}/>:p.kind==='diff'?<DiffPanel panel={p}/>:<AttemptPanel panel={p} task={details.current.get(p.task)}/>}</div></FrameContext.Provider>)}{!current&&<EmptyState title="Open a session, shell or file" description="Select a session on the left, or use + to open a panel."/>}
 </div>{frame?.inline&&rightPanel}{filePrompt&&<Dialog title="Open a file" close={()=>setFilePrompt(false)}><form className="pc-form" onSubmit={e=>{e.preventDefault();void openFile(path);}}><Field label="Path in this task’s worktree"><TextInput autoFocus required value={path} onInput={e=>setPath(e.currentTarget.value)}/></Field><Button type="submit" busy={busy}>Open file</Button><ErrorMessage error={error}/></form></Dialog>}</div>;
}
function WorkspaceCard({task,detail,tokens,members,selected,expanded,shells,onSelect,onToggle,onSession,onShell,onAttempt}:{task:ApiTask;detail?:TaskDetail;tokens?:import('../../../../src/view-model/task-tree').TreeTokens|null;members:ApiTask[];selected:boolean;expanded:boolean;shells:TerminalRecord[];onSelect:()=>void;onToggle:()=>void;onSession:(task:ApiTask)=>void;onShell:(s:TerminalRecord)=>void;onAttempt:(n:number,label:string)=>void}) {
 const status=taskStatus(task),agent=markAgent(task.executor??'unknown'),attempts=detail?.attempts??[];
 const sessions=[...(members.length?members:task.executor?[task]:[]).map(member=>({id:member.id,name:executorLabel(member.executor),agent:markAgent(member.executor??'unknown'),state:['running','queued','needs_input'].includes(member.state)?'Live':'Ended',shell:false,open:()=>onSession(member)})),...shells.map(s=>({id:s.id,name:`Your shell · ${s.title}`,state:s.live?'Idle':'Ended',agent:'shell',shell:true,open:()=>onShell(s)})),...attempts.slice(0,-1).map((a,n)=>({id:`attempt:${n}`,name:`Attempt ${n+1} · ${executorLabel(a.executor)}`,state:'Ended',agent:markAgent(a.executor),shell:false,open:()=>onAttempt(n,`Attempt ${n+1}`)}))];
 return <article className={`pc-workspace-card pc-workspace-card--${status.tone}${selected?' pc-workspace-card--selected':''}`} onClick={event=>{if(!(event.target as HTMLElement).closest('a,button'))onSelect();}}><div className="pc-workspace-card__heading"><AppLink to={routes.task(task.id)} className="pc-workspace-card__title">{task.title??task.goal}</AppLink><IconButton icon="chevron-right" size="sm" variant="quiet" title="Select task for the right panel" onClick={onSelect} aria-label={`Select task: ${task.title??task.goal}`} aria-pressed={selected}><span className={`pc-workspace-dot pc-workspace-dot--${status.tone}`}/></IconButton></div><div className="pc-workspace-card__meta"><Pill>{detail?.machine??task.host??'Local machine'}</Pill><span>{task.repo?.label}</span></div><div className="pc-workspace-card__meta"><span>{status.label}</span><span className="grow"/><span>{tokenValue(tokens??detail?.tokens)}</span></div><div className="pc-workspace-card__sessions"><div className="pc-workspace-card__session-head">{expanded?<span>Sessions</span>:<span className="pc-workspace-session-icons">{sessions.map(s=><Tooltip key={s.id} text={`${s.name} · ${s.state}`}><IconButton className="pc-workspace-session-icon" size="sm" variant="quiet" aria-label={`${s.name} · ${s.state}`} onClick={s.open}>{s.shell?<span aria-hidden="true">⌘</span>:<AgentMark agent={s.agent} size={18}/>}<span className={`pc-workspace-dot pc-workspace-dot--${s.state==='Live'?'info':'neutral'}`}/></IconButton></Tooltip>)}</span>}<Button variant="quiet" size="sm" aria-label={`${expanded?'Collapse':'Expand'} sessions for ${task.title??task.goal}`} aria-expanded={expanded} onClick={onToggle}>{sessions.length} {sessions.length===1?'session':'sessions'} {expanded?'⌃':'⌄'}</Button></div>{expanded&&sessions.map(s=><Button key={s.id} className="pc-workspace-session-row" variant="quiet" onClick={s.open}>{s.shell?<span aria-hidden="true">⌘</span>:<AgentMark agent={s.agent} size={18}/>}<span>{s.name}</span><span className="pc-workspace-dot"/><span>{s.state}</span></Button>)}</div></article>;
}
function RecentDecisions({task,tree}:{task:TaskDetail;tree?:TraceTree}) {return <section><h2>Recent decisions</h2>{traceSteps(task,tree).slice(-3).map((s,n)=><p key={n} className="pc-trace__cap">✓ {s.title}</p>)}</section>;}
function AgentPanel({id,detail,work,openFile}:{id:string;detail?:TaskDetail;work:boolean;openFile:(r:string)=>void}) {
 const {api,state}=useTaskContext(),session=useQuery<SessionInfo>('task.session',{id});
 const [wantsControl,setWantsControl]=useState(false),[driving,setDriving]=useState(false),[takeRequested,setTakeRequested]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
 const controls=useRef<TerminalActions|null>(null),dialogs=useDialogs();
 const take=async(initial?:'starting'|'driving')=>{setBusy(true);try{if(!initial&&session.data?.host==='builtin'&&session.data.live){setWantsControl(true);setTakeRequested(true);}else await takeoverSession({id,state:initial,call:api.call.bind(api),starting:()=>{},ready:info=>{session.setData(info);setWantsControl(true);setTakeRequested(true);}});}catch(e){setError(e);}finally{setBusy(false);}};
 useEffect(()=>{const params=new URLSearchParams(location.hash.split('?')[1]);const pending=params.get('takeover');if(pending==='1'&&!session.data)return;if(pending){params.delete('takeover');history.replaceState(null,'',`${location.hash.split('?')[0]}?${params}`);void take(pending==='starting'||pending==='driving'?pending:undefined);}},[id,session.data?.host,session.data?.live]);
 const initialized=useRef(false);useEffect(()=>{if(session.data&&!initialized.current){initialized.current=true;if(session.data.driving)setWantsControl(true);}},[session.data]);
 const t=state.snapshot?.tasks.find(task=>task.id===id)??detail,s=session.data,live=!!s?.live&&!!t&&['running','queued','needs_input'].includes(t.state);
 const end=async()=>{if(!await dialogs.confirm('End this session? The output and changes are kept.','End session','End session'))return;try{if(t?.interactionMode==='conversation')await changeConversation(api,id,'end');else await api.call(work||detail?.work?'dispatch.stop':'task.stop',{id,expect_rev:t?.rev});session.reload();}catch(e){setError(e);}};
 return <>{dialogs.dialog}<FrameSlot name="title"><div className="pc-workspace-panel-details"><AgentMark agent={markAgent(t?.executor??'unknown')} size={18}/><div><b>{executorLabel(t?.executor)} · {t?.title??t?.goal}</b><span>{t?.repo?.label} · {detail?.branch} · {driving?"You're driving":'Following · read-only'}</span></div>{t&&<Pill tone={taskStatus(t).tone}>{taskStatus(t).label}</Pill>}</div></FrameSlot><FrameSlot name="actions">{t&&['running','queued','needs_input'].includes(t.state)&&<>{driving?<IconButton icon="retry" aria-label="Hand back" title="Hand back" onClick={()=>{controls.current?.release();setDriving(false);setWantsControl(false);setTakeRequested(false);}}/>:(s?.takeover.available||s?.host==='builtin'&&live)&&<IconButton icon="play" variant="primary" aria-label="Take over" title="Take over" busy={busy} onClick={()=>void take()}/>}<IconButton icon="end-session" aria-label="End session" title="End session" onClick={()=>void end()}/></>}</FrameSlot><ErrorMessage error={error??session.error}/>{!s?<Skeleton layout="rows" label="Loading session"/>:s.host==='builtin'?<LazyTerminal id={id} url={s.attach.ws} cols={s.cols} rows={s.rows} live={live} control={wantsControl} resize={wantsControl} onControlChange={setDriving} takeRequested={takeRequested} onTakeSent={()=>setTakeRequested(false)} onActions={a=>{controls.current=a;}} onOpenFile={openFile}/>:s.host==='orca'?<p>This session runs in Orca. Open workspace output from the original host.</p>:<PlainLog id={id}/>}</>;
}
function ShellPanel({panel:p}:{panel:Panel}) {return <><FrameSlot name="title"><div className="pc-workspace-panel-details"><div><b>Your shell · {p.shell?.title}</b><span>{p.shell?.cwd} · login shell</span></div></div></FrameSlot><LazyTerminal id={p.shell!.id} url={p.shell!.attach.ws} cols={p.shell!.cols} rows={p.shell!.rows} live={p.shell!.live} control resize shell/></>;}
function FilePanel({panel:p,close,refresh,openFile}:{panel:Panel;close:()=>void;refresh:()=>void;openFile:(r:string)=>void}) {return <><FrameSlot name="title"><div className="pc-workspace-panel-details"><div><b>{p.file?.path}</b><span>Read-only · opened from the workspace</span></div></div></FrameSlot><FileViewer sidePanel file={p.file} reference={p.reference} onClose={close} onRefresh={refresh} onOpenFile={openFile}/></>;}
function DiffPanel({panel:p}:{panel:Panel}) {const diff=useQuery<{patch:string;truncated:boolean}>('task.diff',{id:p.task,path:p.reference});return <><FrameSlot name="title"><div className="pc-workspace-panel-details"><b>{p.reference} · Changes</b></div></FrameSlot><ErrorMessage error={diff.error}/>{diff.data?<Diff path={p.reference!} patch={diff.data.patch} truncated={diff.data.truncated}/>:<Skeleton layout="rows" label="Loading diff"/>}</>;}
function AttemptPanel({panel:p,task}:{panel:Panel;task?:TaskDetail}) {return <><FrameSlot name="title"><div className="pc-workspace-panel-details"><b>{p.title} · Ended</b></div></FrameSlot><pre className="pc-code-scroll">{task?.attempts[p.attempt??0] ? 'No saved output is available for this earlier attempt.' : 'No attempt recorded.'}</pre></>;}
