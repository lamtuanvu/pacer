import {useEffect,useState} from "preact/hooks";
import {Button} from "../../ds/Button";
import {Disclosure,Field,TextArea} from "../../ds/Controls";
import {EmptyState,LoadingState,TextRow} from "../../ds/Patterns";
import {Page,Section,Stack} from "../../ds/Page";
import {ErrorMessage,TaskLink,useAction,useQuery,useTaskContext} from "../task-shared";
import {executorLabel,taskStatus} from "../../../../src/view-model/words";
import {clock} from "../../../../src/view-model/time";

type Choice={id:string;reason:string};
type Decision={attempt:number;engine:{id:string;version:string};proposal:{state:string;choices?:Choice[];step?:string};selectedCandidateId?:string;validation:string;uncertainty:string[];fallback?:{from:string;reason:string}};
type Node={taskId:string;parentId:string|null;rootId:string;depth:number;title:string;state:string;rev:number;executor:string|null;model:string|null;actualModel:string|null;review:{accepted:boolean}|null;question:{text:string;answer?:string}|null;retryEligibility?:{allowed:boolean;reason?:string};options:{maxAttempts:number};dependencies:string[];waivedChildren:string[];attempts:{startedAt:number;endedAt:number;model?:string|null;actualModel?:string|null}[];decisions:Decision[]};
type Tree={rootId:string;nodes:Node[];totals:{tasks:number;running:number;queued:number;executionSeconds:number;queueWaitSeconds:number;dependencyWaitSeconds:number|null;childWaitSeconds:number|null;capacityWaitSeconds:number|null;provisionalWaits:number;usagePools:{account:string;poolId:string|null;resetEpoch:number|null;observedDeltaPct:number|null;measuredIntervals:number;unknownAttempts:number;attribution:string}[]}};
type Event={seq:number;task_id:string;at:number;kind:string;data:Record<string,unknown>};
type Analytics={groups:{kind:string|null;difficulty:string;runner:string;settings:string;model:string|null;sampleCount:number;successRate:number;confidenceLower:number;confidenceUpper:number;averageDurationS:number|null;averageUsagePct:number|null}[];totalReviews:number;minimumSamples:number};
export const workActionRequestId=(taskId:string,rev:number,kind:"retry"|"answer")=>`${taskId}.${rev}.${kind}`;
const eventLabel=(kind:string)=>({"work.created":"Work created","task.changed":"Task updated","dispatch.reserved":"Executor selected","work.reviewed":"Review recorded","dependencies.changed":"Dependencies changed"} as Record<string,string>)[kind]??kind.replaceAll("."," ").replaceAll("_"," ");
function WorkNode({node,nodes,onChanged}:{node:Node;nodes:Node[];onChanged:()=>void}){
 const action=useAction(),[expanded,setExpanded]=useState(false),[response,setResponse]=useState("");
 const children=nodes.filter(n=>n.parentId===node.taskId);
 const settled=["done","partial","failed","limit","stopped","needs_input"].includes(node.state);
 const canStop=["queued","running","needs_input"].includes(node.state);
 const retryContext=["failed","partial","limit","needs_input","stopped"].includes(node.state)||node.state==="done"&&node.review?.accepted===false;
 const retryAvailable=!!node.retryEligibility?.allowed;
 const canAnswer=node.state==="needs_input"&&!!node.question?.text&&!node.question.answer;
 const canReview=settled&&!node.review;
 const childrenReady=children.every(child=>child.review?.accepted===true||node.waivedChildren?.includes(child.taskId));
 return <li className="pc-work-node"><div className="pc-list-row pc-list-row--compact"><div className="pc-list-row__content">
  <strong>{node.state==="archived"?node.title:<TaskLink id={node.taskId}>{node.title}</TaskLink>}</strong>
  <p className="muted">{taskStatus(node).label}{node.review?node.review.accepted?" · Accepted":" · Rejected":""}{node.executor?` · ${executorLabel(node.executor)}`:""}{node.model?` · requested ${node.model}`:" · requested model unknown"}{node.actualModel?` · observed ${node.actualModel}`:""}</p>
  {node.dependencies.length>0&&<p className="muted">Depends on {node.dependencies.map((id,i)=><span key={id}>{i>0?", ":""}<TaskLink id={id}>{id}</TaskLink></span>)}</p>}
 </div><div className="pc-list-row__actions"><Button size="sm" variant="quiet" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?"Hide details":"Details"}</Button></div></div>
 {expanded&&<div className="pc-work-node__detail"><TextRow label="Task" value={<code>{node.taskId}</code>}/><TextRow label="Attempts" value={node.attempts.length}/>
  {node.decisions.length?<Disclosure summary={`Dispatch history (${node.decisions.length})`}><ol role="list">{node.decisions.map(decision=>{const selected=decision.proposal?.choices?.find(c=>c.id===decision.selectedCandidateId)??decision.proposal?.choices?.[0],attempt=node.attempts[decision.attempt-1];return <li key={decision.attempt}><strong>Attempt {decision.attempt}</strong> · {decision.engine.id}@{decision.engine.version} · {decision.validation}{decision.proposal.step?` · ${decision.proposal.step}`:""}<p>{selected?.reason??"No candidate selected"}</p><p className="muted">Requested model: {attempt?.model??"unknown"} · Observed model: {attempt?.actualModel??"unknown"}</p>{decision.fallback&&<p>Fallback from {decision.fallback.from}: {decision.fallback.reason}</p>}{decision.uncertainty.length>0&&<ul role="list">{decision.uncertainty.map((u,i)=><li key={i}>{u}</li>)}</ul>}</li>;})}</ol></Disclosure>:<p className="muted">Dispatch decision pending.</p>}
  {canReview&&<div className="pc-list-row__actions">{childrenReady?<Button size="sm" busy={action.busy} onClick={()=>void action.run("dispatch.review",{id:node.taskId,accepted:true,expect_rev:node.rev},onChanged)}>Accept</Button>:<p className="muted">Review required child work before accepting.</p>}<Button size="sm" busy={action.busy} onClick={()=>void action.run("dispatch.review",{id:node.taskId,accepted:false,note:"Needs follow-up",expect_rev:node.rev},onChanged)}>Reject</Button></div>}
  {retryAvailable&&<div className="pc-work-retry"><Field label={canAnswer?node.question!.text:"Retry feedback (optional)"}><TextArea rows={3} value={response} maxLength={2000} onInput={event=>setResponse(event.currentTarget.value)}/></Field><Button size="sm" busy={action.busy} disabled={canAnswer&&!response.trim()} onClick={()=>void action.run(canAnswer?"dispatch.answer":"dispatch.retry",{id:node.taskId,expect_rev:node.rev,requestId:workActionRequestId(node.taskId,node.rev,canAnswer?"answer":"retry"),...(canAnswer?{text:response.trim()}:{feedback:response.trim()})},onChanged)}>{canAnswer?"Answer and resume":"Retry work"}</Button></div>}
  {retryContext&&!retryAvailable&&node.retryEligibility?.reason&&<p className="muted">Retry unavailable: {node.retryEligibility.reason}</p>}
  {canStop&&<Button size="sm" variant="quiet" busy={action.busy} onClick={()=>void action.run("dispatch.stop",{id:node.taskId,expect_rev:node.rev},onChanged)}>Stop work</Button>}
  {action.message&&<p role="status">{action.message}</p>}
  {action.error&&<p role="alert">{String(action.error)}</p>}</div>}
 {children.length>0&&<ol role="list" aria-label={`Children of ${node.title}`} className="pc-work-tree">{children.map(child=><WorkNode key={child.taskId} node={child} nodes={nodes} onChanged={onChanged}/>)}</ol>}
 </li>;
}
export function WorkView({id}:{id:string}){
 const {api}=useTaskContext();
 const tree=useQuery<Tree>("dispatch.tree",{id}),analytics=useQuery<Analytics>("dispatch.analytics",{});
 const [events,setEvents]=useState<Event[]>([]),[eventError,setEventError]=useState<unknown>(),[eventVersion,reloadEvents]=useState(0),[eventsLoading,setEventsLoading]=useState(true);
 useEffect(()=>{let cancelled=false;setEventsLoading(true);setEventError(undefined);void(async()=>{try{let after=0;const all:Event[]=[];for(;;){const page=await api.call<{events:Event[];next:number;hasMore:boolean}>("dispatch.events",{id,after});if(cancelled)return;all.push(...page.events);if(!page.hasMore||page.next<=after)break;after=page.next;}if(!cancelled)setEvents(all);}catch(error){if(!cancelled)setEventError(error);}finally{if(!cancelled)setEventsLoading(false);}})();return()=>{cancelled=true;};},[api,id,eventVersion]);
 useEffect(()=>{const timer=setInterval(()=>{tree.reload();reloadEvents(v=>v+1);analytics.reload();},5000);return()=>clearInterval(timer);},[id]);
 const changed=()=>{tree.reload();reloadEvents(v=>v+1);analytics.reload();};
 if(!tree.data)return tree.error?<ErrorMessage error={tree.error}/>:<LoadingState label="Loading work tree…"/>;
 const totals=tree.data.totals,seconds=(value:number|null)=>value===null?"Unknown":`${Math.round(value)} s`;
 const root=tree.data.nodes.find(n=>n.taskId===id)??tree.data.nodes[0];
 return <Page width="full" embedded><Stack space="section">{tree.error&&<ErrorMessage error={tree.error}/>}<Section title="Work tree" description={`${totals.tasks} tasks · ${totals.running} working · ${totals.queued} queued · ${Math.round(totals.executionSeconds)} seconds of recorded execution.`}>
  <p className="muted">Queued time: {seconds(totals.queueWaitSeconds)} · Waiting on dependencies: {seconds(totals.dependencyWaitSeconds)} · Waiting for children: {seconds(totals.childWaitSeconds)} · Capacity wait: {seconds(totals.capacityWaitSeconds)}{totals.provisionalWaits?` · ${totals.provisionalWaits} wait still in progress`:""}</p>
  {totals.usagePools.length?<ul role="list" aria-label="Observed account usage">{totals.usagePools.map((pool,i)=><li key={i}>{pool.account} · {pool.poolId??"pool unknown"} · {pool.observedDeltaPct===null?"Usage unknown":`${pool.observedDeltaPct.toFixed(1)}% observed account movement`}{pool.unknownAttempts?` · ${pool.unknownAttempts} attempts unmeasured`:""} · shared account reading</li>)}</ul>:<p className="muted">No measured account usage for this work.</p>}
  <p className="muted">Root: <TaskLink id={tree.data.rootId}>Open root work</TaskLink>{root?.parentId&&<> · Parent: <TaskLink id={root.parentId}>Open parent work</TaskLink></>}</p>
  {root?<ol role="list" aria-label="Delegated work" className="pc-work-tree"><WorkNode node={root} nodes={tree.data.nodes} onChanged={changed}/></ol>:<EmptyState title="No work steps"/>}
 </Section><Section title="Timeline">
  {eventError&&<ErrorMessage error={eventError}/>}
  {eventsLoading&&!events.length?<LoadingState label="Loading timeline…"/>:<ol role="list" aria-label="Work timeline" className="pc-work-timeline">{events.map(event=><li key={event.seq}><time dateTime={new Date(event.at*1000).toISOString()}>{clock(event.at,Date.now()/1000)}</time> · <TaskLink id={event.task_id}>Work step</TaskLink> · {eventLabel(event.kind)}</li>)}</ol>}
 </Section><Section title="Reviewed model fit" description={analytics.data?`${analytics.data.totalReviews} independent reviews · ranking requires ${analytics.data.minimumSamples} comparable reviews`:"Review evidence unavailable"}>
  {analytics.error&&<ErrorMessage error={analytics.error}/>}
  {analytics.loading&&!analytics.data?<LoadingState label="Loading reviewed outcomes…"/>:analytics.data?.groups.length?<div className="pc-code-scroll"><table className="pc-work-analytics"><thead><tr><th scope="col">Task kind</th><th scope="col">Executor</th><th scope="col">Model</th><th scope="col">Settings</th><th scope="col">Reviews</th><th scope="col">Accepted</th><th scope="col">95% interval</th><th scope="col">Time</th><th scope="col">Usage</th></tr></thead><tbody>{analytics.data.groups.map((g,i)=><tr key={i}><th scope="row">{g.kind??"Unknown"} · {g.difficulty}</th><td title={g.runner}>{executorLabel(g.runner)}</td><td>{g.model??"Actual model unknown"}</td><td><code title={g.settings}>{g.settings.slice(0,8)}</code></td><td>{g.sampleCount}</td><td>{Math.round(g.successRate*100)}%</td><td>{Math.round(g.confidenceLower*100)}–{Math.round(g.confidenceUpper*100)}%</td><td>{g.averageDurationS===null?"Unknown":`${Math.round(g.averageDurationS)} s`}</td><td>{g.averageUsagePct===null?"Unknown":`${g.averageUsagePct.toFixed(1)}%`}</td></tr>)}</tbody></table></div>:!analytics.error?<p className="muted">No independently reviewed outcomes are available yet.</p>:null}
 </Section></Stack></Page>;
}
