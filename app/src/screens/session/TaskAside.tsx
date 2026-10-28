import {ButtonLink,TextAction} from "../../ds/Button";
import {AgentMark} from "../../ds/AgentMark";
import {Icon} from "../../ds/icons";
import {useQuery} from "../task-shared";
import {agentInfo} from "../../../../src/view-model/agents";
import {clock} from "../../../../src/view-model/time";
import {timelineCopy} from "../../../../src/view-model/copy";
import type {TaskDetail} from "../../../../src/core/task-detail";
import type {TaskAsideProps} from "./LazyTaskAside";

const tone=(node:TaskAsideProps["node"])=>node.attention!=="none"?node.attention:node.state.tone;
/** The sticky "Selected task" panel: what the selected card is, where it came from and its latest activity. */
export function TaskAside({node,parent,position,href,viewHref}:TaskAsideProps){
 const detail=useQuery<TaskDetail>("task.get",{id:node.id}).data;
 const agent=node.agents[0];
 const notes=detail?.reviewRequest?.note??detail?.question?.text;
 const activity=detail?timelineCopy(detail.timeline).slice(-4).reverse():[];
 return <aside className="pc-task-aside" aria-label="Selected task">
  <div className="pc-task-aside__section pc-task-aside__head">
   <span className="pc-task-aside__title"><span className={`pc-task-card__dot pc-task-card__dot--${tone(node)}${node.state.live?" pc-status-dot__dot--live":""}`} aria-hidden="true"/><b>{node.title}</b>{agent&&<AgentMark agent={agent} size={20}/>}</span>
   <span className="pc-task-aside__caption">{[position,agent&&agentInfo(agent).name,node.state.label,node.tokens].filter(Boolean).join(" · ")}</span>
   <span className="pc-task-aside__buttons">
    <ButtonLink variant="primary" href={href(node.id)}>Open session</ButtonLink>
    <ButtonLink href={viewHref(node.id,"session").replace("tab=session","tab=work")}>Dispatch trace</ButtonLink>
   </span>
  </div>
  {(parent||detail?.branch)&&<div className="pc-task-aside__section"><span className="pc-task-aside__label"><Icon name="routing"/>Linked work</span>
   {parent&&<span>Parent: <TextAction href={href(parent.id)}>{parent.title}</TextAction></span>}
   {detail?.branch&&<span className="pc-task-aside__caption">Worktree <span className="pc-task-aside__mono">{detail.branch}</span></span>}
  </div>}
  {notes&&<div className="pc-task-aside__section"><span className="pc-task-aside__label"><Icon name="notes"/>Notes</span><span className="pc-task-aside__notes">{notes}</span></div>}
  {activity.length>0&&<div className="pc-task-aside__section"><span className="pc-task-aside__label">Latest activity</span>
   {activity.map((entry,index)=><span key={index} className="pc-task-aside__activity"><span aria-hidden="true">•</span><span className="pc-task-aside__what">{entry.text}</span><span className="pc-task-aside__caption">{clock(entry.at,Date.now()/1000)}</span></span>)}
  </div>}
 </aside>;
}
