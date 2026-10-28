import { TaskTree } from "../../../app/src/ds/TaskTreeNode";
import { ResourceView } from "../../../app/src/screens/session/Session";
import { taskHref } from "../../../app/src/screens/session/task-href";
import type { Resource } from "../../../app/src/screens/session/types";
import type { TaskNodeView } from "../../../src/view-model/task-tree";
/** Two groups of task cards, the way the Tasks page lays them out; the list tests render this to check card content. */
export function SessionsList({ running, recent, query = "" }: { running?: Resource<TaskNodeView[]>; recent?: Resource<TaskNodeView[]>; query?: string }) {
  const href = taskHref(query), view = (id: string, tab: string) => `${href(id)}${query ? "&" : "?"}tab=${tab}`;
  return <div className="pc-sessions-list">{([["Running", running, "No running sessions."], ["Completed", recent, "No completed tasks."]] as const).map(([name, list, empty]) =>
    <section key={name} aria-label={name}><ResourceView value={list} loading={`Loading ${name}…`} empty={empty}>
      {nodes => <TaskTree nodes={nodes} density="regular" href={href} viewHref={view} label={`${name} tasks`} />}</ResourceView></section>)}</div>;
}
