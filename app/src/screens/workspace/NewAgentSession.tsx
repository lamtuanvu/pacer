import { useRef, useState } from 'preact/hooks';
import type { AgentSession } from '../../../../src/session/agents';
import type { TaskDetail } from '../../../../src/core/task-detail';
import type { SessionPreparation } from '../../../../src/session/capabilities';
import { Button } from '../../ds/Button';
import { ChoicePicker } from '../../ds/ChoicePicker';
import { Field, TextArea } from '../../ds/Controls';
import { Skeleton } from '../../ds/Patterns';
import { ErrorMessage, useQuery, useTaskContext } from '../task-shared';

/** Add an independent native conversation to this task’s existing workspace. */
export function NewAgentSession({task,onStarted}:{task:TaskDetail;onStarted:(session:AgentSession)=>void}) {
 const {api}=useTaskContext(),preparation=useQuery<SessionPreparation>('session.prepare',{repo:task.repo.key});
 const [executor,setExecutor]=useState(''),[request,setRequest]=useState(task.brief.goal),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
 const identity=useRef<{request_id:string;key:string}>();
 async function start(){if(busy)return;setBusy(true);setError(undefined);try{
  const key=JSON.stringify([task.id,request,executor]);
  if(identity.current?.key!==key)identity.current={request_id:crypto.randomUUID(),key};
  const result=await api.call<AgentSession>('session.agent.create',{request_id:identity.current.request_id,task_id:task.id,request,executor});
  onStarted(result);
 }catch(e){setError(e);}finally{setBusy(false);}}
 return <div className="pc-form"><p>The agent joins this task in its existing worktree. Each session has its own conversation and controls; changes to files are shared.</p>{preparation.loading?<Skeleton layout="rows" label="Checking agents"/>:<><Field label="Agent"><ChoicePicker value={executor} onValueChange={setExecutor} options={(preparation.data?.executors??[]).map(e=>({value:e.id,label:e.id,agent:e.agent,disabled:!e.available,reason:e.reason}))}/></Field><Field label="Request"><TextArea rows={4} value={request} onInput={e=>setRequest(e.currentTarget.value)}/></Field><Button variant="primary" busy={busy} disabled={!executor||!request.trim()} onClick={()=>void start()}>Start agent session</Button></>}<ErrorMessage error={error??preparation.error}/></div>;
}
