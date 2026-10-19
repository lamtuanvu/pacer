import { SectionHeading } from "../../ds/SectionHeading";
import { ActionButton } from '../ActionButton';
import type { ActionRunner } from '../../data/actions';
import { AgentMark } from '../../ds/AgentMark';
import { Pill } from '../../ds/Pill';
import { phaseWords, taskStatus } from '../../../../src/view-model/words';
import { ResourceView } from './Session';
import type { Resource, SessionData } from './types';
export interface SessionsListProps { running?:Resource<SessionData[]>; recent?:Resource<SessionData[]>; query?:string; runner?:ActionRunner }
/** The caller supplies running and recently ended selectors; no retry/attention decisions live here. */
export function SessionsList({running,recent,query='',runner}:SessionsListProps){
 const rows=(tasks:SessionData[],replay:boolean)=><ul className="pc-sessions-rows">{tasks.map(task=>{const status=taskStatus(task);return <li key={task.id}><AgentMark agent={task.agent}/><div className="pc-sessions-goal"><strong>{task.title ?? task.goal}</strong></div><span className="pc-session-muted" title={task.executor??'Executor unknown'}>{task.repo}</span><Pill tone={status.tone}>{replay?status.label:task.phase?phaseWords(task.phase):status.label}</Pill>{task.elapsed&&<span className="pc-session-muted">{task.elapsed}</span>}{(task.changesSummary || !replay) && <span className="pc-session-muted">{task.changesSummary??'Changes and output pending'}</span>}<a className={`pc-btn pc-btn--secondary pc-btn--sm${replay?' pc-session-replay':''}`} aria-label={`${replay?'Replay':'Watch'} ${task.title??task.goal}`} href={`#/sessions/${encodeURIComponent(task.id)}${query?(query.startsWith('?')?query:`?${query}`):''}`}>{replay?'Replay':'Watch'}</a>{!replay&&task.state==='running'&&runner&&<ActionButton runner={runner} id={`${task.id}:takeover`} action={{label:'Take over',op:'task.takeover',params:{id:task.id}}}/>}</li>;})}</ul>;
 return <div className="pc-sessions-list"><section aria-label="Running"><SectionHeading>Running</SectionHeading><ResourceView value={running} loading="Loading running sessions…" empty="No running sessions.">{tasks=>rows(tasks,false)}</ResourceView></section><section aria-label="Recently ended"><SectionHeading>Recently ended</SectionHeading><ResourceView value={recent} loading="Loading recently ended sessions…" empty="No recently ended sessions.">{tasks=>rows(tasks,true)}</ResourceView></section></div>;
}
export default SessionsList;
