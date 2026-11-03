import { useState } from 'preact/hooks';
import type { AgentSession } from '../../../../src/session/agents';
import { agentSessionLabel } from '../../../../src/view-model/words';
import { AgentMark } from '../../ds/AgentMark';
import { markAgent } from '../../../../src/view-model/agents';
import { Button } from '../../ds/Button';
import { useDialogs } from '../../ds/useDialogs';
import { FrameSlot } from '../../shell/slots';
import { LazyTerminal } from '../../term/LazyTerminal';
import { ErrorMessage, useQuery, useTaskContext } from '../task-shared';

export function TaskAgentPanel({session:initial,onChanged,openFile}:{session:AgentSession;onChanged:()=>void;openFile:(reference:string)=>void}) {
 const {api}=useTaskContext(),dialogs=useDialogs();
 const query=useQuery<AgentSession>('session.agent.get',{task_id:initial.task_id,id:initial.id});
 const s=query.data??initial;
 const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
 async function change(action:'end'|'retry'|'resume') {
  if(busy)return;
  if(action==='end'&&!await dialogs.confirm('End this agent session? Other sessions keep running. Output and changes are kept.','End session','End session'))return;
  setBusy(true);setError(undefined);
  try{const next=await api.call<AgentSession>(`session.agent.${action}`,{task_id:s.task_id,id:s.id,expect_rev:s.rev});query.setData(next);onChanged();}catch(e){setError(e);}finally{setBusy(false);}
 }
 return <>{dialogs.dialog}<FrameSlot name="title"><div className="pc-workspace-panel-details"><AgentMark agent={markAgent(s.executor)} size={18}/><div><b title={s.request}>{agentSessionLabel(s.executor,s.ordinal)} · {s.request}</b><span>{s.live?'Live session':s.state==='failed'?'Session failed':s.state==='starting'?'Starting session':'Ended session'} · Attempt {s.attempt}</span></div></div></FrameSlot>
 <FrameSlot name="actions">{s.live||s.state==='starting'?<Button variant="danger" busy={busy} onClick={()=>void change('end')}>End session</Button>:<><Button variant="quiet" busy={busy} onClick={()=>void change('retry')}>Start fresh conversation</Button>{s.nativeId&&<Button variant="quiet" busy={busy} onClick={()=>void change('resume')}>Resume conversation</Button>}</>}</FrameSlot>
 <ErrorMessage error={error??query.error??(s.error?new Error(s.error):undefined)}/>
 <LazyTerminal key={`${s.id}:${s.attempt}`} id={`agent:${s.id}:${s.attempt}`} url={s.attach.ws} cols={s.cols} rows={s.rows} live={s.live} control={s.live} resize={s.live} conversation onOpenFile={openFile}/>
 </>;
}
