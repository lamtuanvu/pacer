import { useRef, useState } from 'preact/hooks';
import type { TaskDetail } from '../../../../src/core/task-detail';
import type { SessionPreparation } from '../../../../src/session/capabilities';
import { Button } from '../../ds/Button';
import { ChoicePicker } from '../../ds/ChoicePicker';
import { Field, TextArea } from '../../ds/Controls';
import { Skeleton } from '../../ds/Patterns';
import { ErrorMessage, useQuery, useTaskContext } from '../task-shared';

/** The current service creates conversations as tasks; it cannot append a second agent to a task. */
export function NewAgentSession({task}:{task:TaskDetail}) {
 const {api}=useTaskContext(),preparation=useQuery<SessionPreparation>('session.prepare',{repo:task.repo.key});
 const [executor,setExecutor]=useState(''),[request,setRequest]=useState(task.brief.goal),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
 const identity=useRef<{request_id:string;draftId:string}>();
 async function start(){if(busy)return;setBusy(true);setError(undefined);try{
  if(!identity.current){const draft=await api.call<{id:string}>('session.draft.create',{});identity.current={request_id:crypto.randomUUID(),draftId:draft.id};}
  const result=await api.call<{task_id:string}>('session.create',{...identity.current,request,repo:task.repo.key,executor,workspace:{mode:'current',path:task.worktree??task.repo.path},attachments:[]});
  location.hash=`#/workspace?task=${encodeURIComponent(result.task_id)}&panel=session&takeover=1`;
 }catch(e){setError(e);}finally{setBusy(false);}}
 return <div className="pc-form"><p>This service starts a new task for each interactive agent session. The new session uses this task’s worktree and brief.</p>{preparation.loading?<Skeleton layout="rows" label="Checking agents"/>:<><Field label="Agent"><ChoicePicker value={executor} onValueChange={setExecutor} options={(preparation.data?.executors??[]).map(e=>({value:e.id,label:e.id,agent:e.agent,disabled:!e.available,reason:e.reason}))}/></Field><Field label="Request"><TextArea rows={4} value={request} onInput={e=>setRequest(e.currentTarget.value)}/></Field><Button variant="primary" busy={busy} disabled={!executor||!request.trim()} onClick={()=>void start()}>Start agent session</Button></>}<ErrorMessage error={error??preparation.error}/></div>;
}
