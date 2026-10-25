import type { SessionData } from './types';
import { ButtonLink } from '../../ds/Button';
import { AgentMark } from '../../ds/AgentMark';
import { SectionHeading } from '../../ds/SectionHeading';
import { taskStatus } from '../../../../src/view-model/words';

export function TaskNavigator({selectedId,selectedTask,running,recent,query=''}: { selectedId: string; selectedTask?: SessionData; running: SessionData[]; recent: SessionData[]; query?: string }) {
 const groups=[['Running',running],['Completed',recent]] as const;
 const present=[...running,...recent].some(task=>task.id===selectedId);
 const href=(id:string)=>`#/tasks/${encodeURIComponent(id)}${query?(query.startsWith('?')?query:`?${query}`):''}`;
 const row=(task:SessionData)=><li key={task.id}><ButtonLink href={href(task.id)} variant="quiet" size="sm" className={`pc-task-nav__item${task.id===selectedId?' pc-task-nav__item--current':''}`} aria-current={task.id===selectedId?'page':undefined} title={task.title??task.goal}>
  <AgentMark agent={task.agent}/><span className="pc-task-nav__copy"><strong>{task.title??task.goal}</strong><span title={task.repo}>{task.repo}</span><small>{taskStatus(task).label}</small></span>
 </ButtonLink></li>;
 return <nav className="pc-task-nav" aria-label="Task navigator"><div className="pc-task-nav__head"><strong>Tasks</strong><span>{running.length+recent.length+(present?0:1)}</span></div><div className="pc-task-nav__scroll">
  {!present&&selectedTask&&<section aria-label="Current task"><SectionHeading as="h3">Current task</SectionHeading><ul>{row(selectedTask)}</ul></section>}
  {groups.map(([name,tasks])=>tasks.length>0&&<section key={name} aria-label={name}><SectionHeading as="h3">{name}</SectionHeading><ul>{tasks.map(row)}</ul></section>)}
 </div></nav>;
}
