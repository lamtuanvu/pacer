import {useNavigation} from "../../navigation";
import {hrefFor,routes} from "../../router";
import {ButtonLink,TextAction} from "../../ds/Button";
import {AgentMark} from "../../ds/AgentMark";
import {DensityContext} from "../../ds/Density";
import {Icon} from "../../ds/icons";
import {useQuery,useTaskContext} from "../task-shared";
import {agentInfo} from "../../../../src/view-model/agents";
import {clock,duration} from "../../../../src/view-model/time";
import {timelineCopy} from "../../../../src/view-model/copy";
import {taskHeading} from "../../../../src/view-model/titles";
import {plannerMeter} from "../../../../src/view-model/selectors";
import type {TaskDetail} from "../../../../src/core/task-detail";
import type {TaskAsideProps} from "./LazyTaskAside";

const tone=(node:TaskAsideProps["node"])=>node.attention!=="none"?node.attention:node.state.tone;
/** The sticky "Selected task" panel: what the selected card is, where it came from and its latest activity. */
export function TaskAside({node,parent,position,href}:TaskAsideProps){
 const {current}=useNavigation();
 const detail=useQuery<TaskDetail>("task.get",{id:node.id}).data;
 const {state}=useTaskContext();
 const planner=state.snapshot?plannerMeter(state.snapshot):null;
 const heading=state.snapshot?.tasks.find(task=>task.id===node.id)?.title;
 const agent=node.agents[0];
 const notes=detail?.question?.text??detail?.reviewRequest?.note??detail?.brief?.constraints??detail?.brief?.context??detail?.brief?.scope;
 const ran=detail?.startedAt!=null?duration((detail.endedAt??Date.now()/1000)-detail.startedAt):undefined;
 const activity=detail?timelineCopy(detail.timeline).slice(-4).reverse():[];
 return <aside className="pc-task-aside" aria-label="Selected task">
  <div className="pc-task-aside__section pc-task-aside__head">
   <span className="pc-task-aside__title"><span className={`pc-task-card__dot pc-task-card__dot--child pc-task-card__dot--${tone(node)}${node.state.live?" pc-status-dot__dot--live":""}`} aria-hidden="true"/><TextAction href={hrefFor(routes.task(node.id,current.query))}><b title={node.title}>{heading||taskHeading(node.title)}</b></TextAction>{agent&&<AgentMark agent={agent} size={20}/>}</span>
   <span className="pc-task-aside__caption">{[position,agent&&agentInfo(agent).name,ran,node.tokens].filter(Boolean).join(" · ")}</span>
   <DensityContext.Provider value="settings"><span className="pc-task-aside__buttons">
    <ButtonLink variant="primary" href={hrefFor(routes.workspace(node.id), current.query)}>Open workspace</ButtonLink>
    <ButtonLink href={hrefFor(routes.trace(node.id,current.query))}>Open task page</ButtonLink>
   </span></DensityContext.Provider>
  </div>
  <div className="pc-task-aside__section"><span className="pc-task-aside__label"><Icon name="routing"/>Linked work</span>
   {parent&&<span>Parent: <TextAction href={href(parent.id)} title={parent.title}>{state.snapshot?.tasks.find(task=>task.id===parent.id)?.title||taskHeading(parent.title)}</TextAction></span>}
   <span className="pc-task-aside__caption">{(parent||detail?.source==="planner")&&<>Delegated{planner?` by ${agentInfo(planner.agent).name}`:""} via <span className="pc-task-aside__mono">pacer delegate</span> · </>}{detail?.branch||node.branch?<>worktree <span className="pc-task-aside__mono">{detail?.branch??node.branch}</span></>:"Worktree not reported"}</span>
  </div>
  <div className="pc-task-aside__section"><span className="pc-task-aside__label"><Icon name="notes"/>Notes</span><span className="pc-task-aside__notes">{notes??"No notes yet."}</span></div>
  {activity.length>0&&<div className="pc-task-aside__section"><span className="pc-task-aside__label">Latest activity</span>
   {activity.map((entry,index)=><span key={index} className="pc-task-aside__activity"><span aria-hidden="true">•</span><span className="pc-task-aside__what">{entry.text}</span><span className="pc-task-aside__caption">{clock(entry.at,Date.now()/1000)}</span></span>)}
  </div>}
 </aside>;
}

/** Read missing root metadata outside the design-system presentation components. */
export function TaskBranch({id}:{id:string}){
 const {data,error}=useQuery<TaskDetail>("task.get",{id});
 return <span className="pc-task-card__branch" title={error?"Branch unavailable":data?.branch??undefined}>{data?.branch??"—"}</span>;
}
