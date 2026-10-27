import { ListRowLink } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { AgentMark } from "../../ds/AgentMark";
import { StatusPill } from "../../ds/StatusPill";
import { taskStatus, taskOutcome } from "../../../../src/view-model/words";
import { ResourceView } from "./resource";
import type { Resource, SessionData } from './types';
import { Page } from '../../ds/Page';
export interface SessionsListProps { running?:Resource<SessionData[]>; recent?:Resource<SessionData[]>; query?:string }
/** The caller supplies running and recently ended selectors; no retry/attention decisions live here. */
export function SessionsList({running,recent,query=''}:SessionsListProps){
 const rows=(tasks:SessionData[],replay:boolean)=><ul className="pc-sessions-rows">{tasks.map(task=><li key={task.id}><ListRowLink href={`#/tasks/${encodeURIComponent(task.id)}${query?(query.startsWith('?')?query:`?${query}`):''}`} className="pc-task-list-row">
 <span className="pc-list-row__leading"><AgentMark agent={task.agent}/></span>
 <span className="pc-list-row__content"><strong className="pc-ellipsis" title={task.title??task.goal}>{task.title??task.goal}</strong></span>
 <span className="pc-list-row__meta"><span className="pc-sessions-repo" title={task.repo}>{task.repo}</span><StatusPill status={taskStatus(task)}/>{replay&&<span>{taskOutcome(task).label}</span>}{task.elapsed&&<span>{task.elapsed}</span>}{(task.changesSummary||!replay)&&<span>{task.changesSummary??'Changes and output pending'}</span>}</span>
 </ListRowLink></li>)}</ul>;
 return <Page width="full" embedded className="pc-sessions-list"><section className="pc-card-section" aria-label="Running"><div className="pc-card-section__head"><SectionHeading>Running</SectionHeading></div><ResourceView value={running} loading="Loading running sessions…" empty="No running sessions.">{tasks=>rows(tasks,false)}</ResourceView></section><section className="pc-card-section" aria-label="Completed"><div className="pc-card-section__head"><SectionHeading>Completed</SectionHeading></div><ResourceView value={recent} loading="Loading task history…" empty="No completed tasks.">{tasks=>rows(tasks,true)}</ResourceView></section></Page>;
}
export default SessionsList;
