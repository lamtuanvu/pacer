import { ListRow } from "../../ds/Patterns";
import { ButtonLink } from "../../ds/Button";
import { SectionHeading } from "../../ds/SectionHeading";
import { ActionButton } from "../ActionButton";
import type { ActionRunner } from '../../data/actions';
import { AgentMark } from "../../ds/AgentMark";
import { StatusPill } from "../../ds/StatusPill";
import { taskStatus, taskOutcome } from "../../../../src/view-model/words";
import { ResourceView } from "./Session";
import type { Resource, SessionData } from './types';
export interface SessionsListProps { running?:Resource<SessionData[]>; recent?:Resource<SessionData[]>; query?:string; runner?:ActionRunner }
/** The caller supplies running and recently ended selectors; no retry/attention decisions live here. */
export function SessionsList({running,recent,query='',runner}:SessionsListProps){
 const rows=(tasks:SessionData[],replay:boolean)=><ul className="pc-sessions-rows">{tasks.map(task=><li key={task.id}><ListRow className={replay?"pc-list-row--stretch":undefined}
 leading={<AgentMark agent={task.agent}/>}
 content={<strong className="pc-ellipsis" title={task.title??task.goal}>{task.title??task.goal}</strong>}
 meta={<><span title={task.executor??'Executor unknown'}>{task.repo}</span><StatusPill status={taskStatus(task)}/>{replay&&<span>{taskOutcome(task).label}</span>}{task.elapsed&&<span>{task.elapsed}</span>}{(task.changesSummary||!replay)&&<span>{task.changesSummary??'Changes and output pending'}</span>}</>}
 actions={<><ButtonLink size="sm" className={replay?"pc-row-destination":undefined} aria-label={`${replay?'View result':'Watch'} ${task.title??task.goal}`} href={`#/tasks/${encodeURIComponent(task.id)}${query?(query.startsWith('?')?query:`?${query}`):''}`}>{replay?'View result':'Watch'}</ButtonLink>{!replay&&task.state==='running'&&runner&&<ActionButton runner={runner} id={`${task.id}:takeover`} action={{label:'Take over',op:'task.takeover',params:{id:task.id}}}/>}</>}
 /></li>)}</ul>;
 return <div className="pc-sessions-list"><section aria-label="Running"><SectionHeading>Running</SectionHeading><ResourceView value={running} loading="Loading running sessions…" empty="No running sessions.">{tasks=>rows(tasks,false)}</ResourceView></section><section aria-label="Completed"><SectionHeading>Completed</SectionHeading><ResourceView value={recent} loading="Loading task history…" empty="No completed tasks.">{tasks=>rows(tasks,true)}</ResourceView></section></div>;
}
export default SessionsList;
