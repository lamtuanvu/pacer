import { NowCard, CostTiles, Acceptance } from "./Overview";
import { TaskActions } from "./TaskActions";
import type { TaskDetail } from "../../../../src/core/task-detail";
import { agentInfo, markAgent } from "../../../../src/view-model/agents";
import { clock, durationWords } from "../../../../src/view-model/time";
import { kindCopy } from "../../../../src/view-model/copy";
import { agentSlot } from "../insights/model";
import { taskPageStatus as taskStatus } from "../../../../src/view-model/words";
import { ButtonLink, TextAction } from "../../ds/Button";
import { AgentMark } from "../../ds/AgentMark";
import { Pill } from "../../ds/Pill";
import { EmptyState, Skeleton } from "../../ds/Patterns";
import { hrefFor, routes, withQuery, type RouteQuery } from "../../router";
import { ErrorMessage, useQuery, useTaskContext } from "../task-shared";
import { candidateAgent, decisionCaption, executorTokenRole, childState, childTokens, tokenValue, traceCandidates, traceSteps, traceStepState, type TraceTree } from "./model";

const name = (agent:string) => agentInfo(markAgent(agent)).name;
function Agent({agent,chip=false}:{agent:string;chip?:boolean}) {
  return <span className={chip?"pc-trace__agent-chip":"pc-trace__agent"}><AgentMark agent={markAgent(agent)} size={chip?16:20} labelled={false}/>{name(agent)}</span>;
}
/** Recorded task facts only: planning attribution and missing historical decisions remain unknown. */
export function Trace({id,query}:{id:string;query:RouteQuery}) {
  const {state}=useTaskContext();
  const task=useQuery<TaskDetail>("task.get",{id});
  const tree=useQuery<TraceTree>("dispatch.tree",{id});
  if (!task.data) return task.error ? <ErrorMessage error={task.error}/> : <Skeleton layout="task" label="Loading dispatch trace…"/>;
  const t=task.data, root=tree.data?.nodes.find(n=>n.taskId===id), nodes=tree.data?.nodes ?? [];
  const steps=traceSteps(t,tree.data), totals=tree.data?.totals.tokens ?? (t.work?undefined:t.tokens);
  const children=nodes.filter(n=>n.taskId!==id);
  const decisionNode=root?.decisions.length ? root : children.find(n=>n.decisions.length);
  const decision=decisionNode?.decisions.at(-1), candidates=traceCandidates(decision,t);
  const subtask=decisionNode && decisionNode.taskId!==id ? children.indexOf(decisionNode)+1 : undefined;
  const status=taskStatus(t), now=Date.now()/1000;
  const started=t.startedAt==null?null:clock(t.startedAt,now);
  const ran=t.startedAt==null || t.endedAt==null && !["running","queued"].includes(t.state)?null:durationWords((t.endedAt??now)-t.startedAt);
  const day=clock(t.startedAt??t.timeline[0]?.at??t.updatedAt,now), today=!day.includes(" ");
  const acceptanceAt=t.timeline.findLast(e=>e.text.toLowerCase()===`acceptance ${t.acceptance.state}`)?.at;
  const reviewHref=hrefFor(routes.taskReview(id,query));
  const settled=!["running","queued","needs_input"].includes(t.state);
  const reviewable=settled && !t.review && !t.resolved && !t.dismissed && !t.retriedBy && state.features.ops.has(t.work?"dispatch.review":"task.review");
  const agents=[...new Set((nodes.length?nodes.flatMap(n=>n.attempts.map(a=>markAgent(a.executor))):t.attempts.map(a=>markAgent(a.executor))))];
  const attempts=nodes.length?nodes.reduce((sum,n)=>sum+n.attempts.length,0):t.attempts.length;
  const retries=nodes.length?nodes.reduce((sum,n)=>sum+Math.max(0,n.attempts.length-1),0):Math.max(0,t.attempts.length-1);
  const groups=new Map<string,{agent:string;total:number;measuredAttempts:number;partialAttempts:number;lowerBound:boolean;attempts:number}>();
  for (const row of totals?.byExecutor??[]) {
    const group=groups.get(row.agent)??{agent:row.agent,total:0,measuredAttempts:0,partialAttempts:0,lowerBound:false,attempts:0};
    group.total+=row.total;group.measuredAttempts+=row.measuredAttempts;group.partialAttempts+=row.partialAttempts;
    group.lowerBound ||= row.unknownAttempts>0 || row.partialAttempts>0;group.attempts+=row.attempts;groups.set(row.agent,group);
  }
  const tokenRows=[...groups.values()].sort((a,b)=>b.total-a.total);
  const measuredTotal=tokenRows.reduce((sum,r)=>sum+r.total,0);
  let offset=0;
  return <div className="pc-trace">
    <nav aria-label="Breadcrumb" className="pc-trace__breadcrumb pc-trace__cap"><TextAction href={hrefFor(routes.tasks(query))}>Tasks</TextAction><span aria-hidden="true">/</span><span title="Task ID is available from the task menu">{t.acceptance.state==="failed"?"Needs attention":["running","queued"].includes(t.state)?"Running":reviewable?"Needs your review":today?"Earlier today":day.replace(/ \d\d:\d\d$/,"")}</span></nav>
    <header className="pc-trace__header">
      <div className="pc-trace__identity"><h1>{t.title?.trim()||t.fullTitle?.trim()||t.goal}</h1>
        <div className="pc-trace__meta"><Pill tone={status.tone}>{status.label}</Pill>{status.label!=="Checks failed"&&<Pill tone={t.acceptance.state==="passed"?"good":t.acceptance.state==="failed"?"bad":"neutral"}>{t.acceptance.state==="passed"?"Checks passed":t.acceptance.state==="failed"?"Checks failed":"Not recorded"}</Pill>}{t.kind && <Pill>{kindCopy(t.kind)}</Pill>}<span className="pc-trace__cap pc-trace__mono">{t.repo.label} · {t.branch??"Not recorded"}</span><span className="pc-trace__cap">{started ? `Started ${started}${ran ? ` · ${ran}` : ""}` : "Not recorded"}</span></div>
      </div>
      <div className="pc-trace__actions">
        <TaskActions task={t} query={query} reload={task.reload}/>
      </div>
    </header>
    {task.error && <ErrorMessage error={task.error}/>}
    <NowCard task={t}/>
    <CostTiles task={t} tokens={totals} agentsUsed={agents.length} attempts={attempts} subtasks={children.length} retries={retries}/>
    <div className="pc-trace__columns">
      <section aria-labelledby="trace-h" className="pc-trace__timeline">
        <div className="pc-trace__band"><h2 id="trace-h">Dispatch trace</h2><span className="pc-trace__cap">Every decision pacer made, in order</span></div>
        {t.work && tree.error && <ErrorMessage error={tree.error}/>}
        {steps.length ? <ol className="pc-trace__steps">{steps.map((step,index)=>{
          const stepState=traceStepState(t,index,steps.length);
          return <li key={`${step.at}:${index}`}>
          <span className="pc-trace__track"><span aria-hidden="true" className={`pc-trace__circle pc-trace__circle--${stepState.tone}`}>{stepState.glyph}</span>{stepState.rail && <span className="pc-trace__line"/>}</span>
          <div className="pc-trace__step-body"><div className="pc-trace__step-title"><b>{step.title}</b>{step.agents.map(agent=><Agent key={agent} agent={agent} chip/>)}</div><span className="pc-trace__cap pc-trace__detail">{step.detail}</span>{/session|executor|started|attempt/i.test(step.title)&&<TextAction href={hrefFor(routes.workspace(id, "session"))}>Open session output</TextAction>}
            {step.children && <div className="pc-trace__subtasks">{step.children.map(child=>{
              const childStatus=childState(child), chosen=child.decisions.at(-1);
              return <div className="pc-trace__subtask" key={child.taskId}><span title={childStatus.label} className={`pc-trace__state pc-trace__state--${childStatus.tone}`}>{childStatus.glyph}</span><span className="pc-trace__child-title"><TextAction href={hrefFor(routes.trace(child.taskId,query))} title={child.title}>{child.title}</TextAction><span className="pc-trace__cap">{chosen?traceCandidates(chosen).find(c=>c.verdict==="Chosen")?.why??"Not recorded":"Not recorded"}</span></span><span>{child.executor?<Agent agent={child.executor}/>:"Not recorded"}</span><b className="pc-trace__right">{childTokens(child)}</b></div>;
            })}</div>}
          </div><span className="pc-trace__cap pc-trace__right">{step.at==null || !Number.isFinite(step.at)?"Not recorded":clock(step.at,now)}<br/><b>{step.tokens}</b></span>
        </li>;})}</ol> : <EmptyState title="Not recorded" description="No task activity recorded."/>}
      </section>
      <aside className="pc-trace__aside">
        <section aria-labelledby="tok-h" className="pc-trace__card"><h2 id="tok-h">Tokens by agent</h2>
          <svg className="pc-trace__bar" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label={measuredTotal?tokenRows.map(r=>`${name(r.agent)} ${tokenValue(r)} tokens`).join(", "):"Token usage not measured"}>{tokenRows.map((row,index)=>{
            const width=measuredTotal?row.total/measuredTotal*100:0,x=offset;offset+=width;
            return <rect key={row.agent} x={x} y="0" width={width} height="14" className={`pc-trace__color${agentSlot(row.agent)}`}/>;
          })}</svg>
          {tokenRows.map((row,index)=><div className="pc-trace__token-row" key={row.agent}><span className={`pc-trace__swatch pc-trace__color${agentSlot(row.agent)}`}/><AgentMark agent={markAgent(row.agent)} size={20} labelled={false}/><span className="pc-trace__token-name"><b>{name(row.agent)}</b> <span className="pc-trace__cap">{executorTokenRole(row.agent,row.attempts,children)}</span></span><b>{tokenValue(row)}</b><span className="pc-trace__cap pc-trace__share">{!totals?.lowerBound && measuredTotal?`${Math.round(row.total/measuredTotal*100)}%`:""}</span></div>)}
          <span className="pc-trace__cap">{attempts} {attempts===1?"attempt":"attempts"} · Planning and review tokens: Not recorded</span>
        </section>
        <section aria-labelledby="cand-h" className="pc-trace__candidates"><div className="pc-trace__candidate-head"><h2 id="cand-h">Who was considered</h2>{(decision || candidates.length>0) && <span className="pc-trace__cap">{decisionCaption(decision,subtask,!!t.routing)}</span>}</div>
          {candidates.length?candidates.map((c,index)=><div className={`pc-trace__candidate${c.verdict==="Chosen"?" pc-trace__candidate--chosen":""}`} key={`${c.agent}:${index}`}><span aria-hidden="true" className={`pc-trace__state pc-trace__state--${c.tone}`}>{c.verdict==="Skipped"?"◐":"✓"}</span><AgentMark agent={markAgent(candidateAgent(c.agent))} size={20} labelled={false}/><span className="pc-trace__candidate-copy"><b>{name(c.agent)}</b><span className="pc-trace__cap">{c.why}</span></span><Pill tone={c.tone}>{c.verdict}</Pill></div>):<p className="pc-trace__no-candidates pc-trace__cap">No alternatives were recorded for this step.</p>}
        </section>
        <Acceptance task={t}/>
      </aside>
    </div>
  </div>;
}
