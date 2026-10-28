import { TaskTree } from '../../ds/TaskTreeNode';
import type { TaskNodeView } from '../../../../src/view-model/task-tree';
import { taskHref } from './task-href';

/** The Session panel's task list, one flat tree in attention order. The caller pins the open task (scopedTaskTree `pinned`), so it appears in place or under its parent. */
export function TaskNavigator({selectedId,nodes,query=''}: { selectedId: string; nodes: TaskNodeView[]; query?: string }) {
 return <nav className="pc-task-nav" aria-label="Task navigator"><div className="pc-task-nav__head"><strong>Sessions</strong></div><div className="pc-task-nav__scroll">
  <TaskTree nodes={nodes} density="compact" href={taskHref(query)} selectedId={selectedId} label="Sessions"/>
 </div></nav>;
}
