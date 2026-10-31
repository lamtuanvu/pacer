import { useState } from 'preact/hooks';
import type { TaskDetail } from '../../../../src/core/task-detail';
import { Button, ButtonLink } from '../../ds/Button';
import { Field, TextArea } from '../../ds/Controls';
import { Dialog } from '../../ds/Dialog';
import { hrefFor, routes, type RouteQuery } from '../../router';
import { useResultAction, type WorkResult } from '../review/ResultPage';
import { verdictParams } from '../review/model';
import { Failure } from '../failure/Failure';
import { ErrorMessage, useQuery, useTaskContext } from '../task-shared';

export function TaskActions({task:t,query,reload,embedded=false}:{task:TaskDetail;query:RouteQuery;reload:()=>void;embedded?:boolean}) {
 const {state}=useTaskContext(),action=useResultAction();
 const [reject,setReject]=useState(false),[retry,setRetry]=useState(false),[note,setNote]=useState('');
 const tree=useQuery<WorkResult>('dispatch.tree',{id:t.id});
 const session=useQuery<import('../../../../src/session/service').SessionInfo>('task.session',{id:t.id});
 const failed=t.acceptance.state==='failed'||['failed','partial','limit'].includes(t.state);
 const active=['running','queued','needs_input'].includes(t.state);
 const reviewable=t.state==='done'&&!active&&!failed&&!t.review&&!t.resolved&&!t.dismissed&&!t.retriedBy&&state.features.ops.has(t.work?'dispatch.review':'task.review');
 const node=tree.data?.nodes.find(n=>n.taskId===t.id);
 const ready=!t.work||!!node&&tree.data!.nodes.filter(n=>n.parentId===t.id).every(n=>n.review?.accepted||node.waivedChildren.includes(n.taskId));
 const stop=state.snapshot?.attention?.filter(i=>i.taskId===t.id).flatMap(i=>i.actions).find(a=>a.op==='task.stop'||a.op==='dispatch.stop');
 const submit=(accept:boolean)=>void action.run(t.work?'dispatch.review':'task.review',t.work?{id:t.id,expect_rev:t.rev,accepted:accept,...(!accept?{note:note.trim()}:{})}:verdictParams(t,{verdict:accept?'accept':'reject',note}),()=>{setReject(false);reload();});
 return <>{!embedded&&<ButtonLink href={hrefFor(routes.workspace(t.id))}>Open workspace</ButtonLink>}
 {active&&<><Button busy={action.busy} onClick={()=>void action.run(t.work?'dispatch.stop':'task.stop',{id:t.id,expect_rev:t.rev},reload)}>Stop</Button>{(session.data?.takeover.available||session.data?.host==="builtin"&&session.data.live)&&<ButtonLink variant="primary" href={`${hrefFor(routes.workspace(t.id,'session'))}&takeover=1`}>Take over</ButtonLink>}</>}
 {reviewable&&<><Button onClick={()=>setReject(true)}>Reject</Button>{ready?<Button variant="primary" busy={action.busy} onClick={()=>submit(true)}>Accept result</Button>:<span className="pc-trace__cap">Review required child work before accepting.</span>}</>}
 {failed&&<>{stop&&<Button busy={action.busy} onClick={()=>void action.run(stop.op,{...stop.params,expect_rev:t.rev},reload)}>Stop task</Button>}<Button variant="primary" onClick={()=>setRetry(true)}>Retry</Button></>}
 <ErrorMessage error={action.error}/>
 {reject&&<Dialog title="Why reject this result?" close={()=>setReject(false)}><Field label="Rejection note"><TextArea autoFocus rows={3} value={note} onInput={e=>setNote(e.currentTarget.value)}/></Field><Button onClick={()=>setReject(false)}>Cancel</Button><Button variant="primary" disabled={!note.trim()} busy={action.busy} onClick={()=>submit(false)}>Reject result</Button></Dialog>}
 {retry&&<Dialog title="Retry task" close={()=>setRetry(false)}><Failure task={t} query={query} reload={reload} tree={tree.data} retryOnly/></Dialog>}</>;
}
