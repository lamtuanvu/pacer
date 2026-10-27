import { SectionHeading } from '../../ds/SectionHeading';
import { TaskTree } from '../../ds/TaskTreeNode';
import type { TaskNodeView } from '../../../../src/view-model/task-tree';
import { taskHref } from './SessionsList';

/** The Session panel's task tree. The caller includes the selected task, so it always appears in its group or under its parent. */
export function TaskNavigator({selectedId,nodes,query=''}: { selectedId: string; nodes: TaskNodeView[]; query?: string }) {
 const groups=[['Running',nodes.filter(node=>node.active)],['Completed',nodes.filter(node=>!node.active)]] as const;
 const href=taskHref(query);
 return <nav className="pc-task-nav" aria-label="Task navigator"><div className="pc-task-nav__head"><strong>Tasks</strong><span>{nodes.length}</span></div><div className="pc-task-nav__scroll">
  {groups.map(([name,list])=>list.length>0&&<section key={name} aria-label={name}><SectionHeading as="h3">{name}</SectionHeading><TaskTree nodes={list} density="compact" href={href} selectedId={selectedId} label={`${name} tasks`}/></section>)}
 </div></nav>;
}
