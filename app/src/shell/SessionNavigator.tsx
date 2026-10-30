import type { TaskDetail } from "../../../src/core/task-detail";
import type { ApiTask } from "../../../src/api/read-model/types";
import { scopedTaskTree, taskTree, workTasks, type WorkRow } from "../../../src/view-model/task-tree";
import { useQuery, useTaskContext } from "../screens/task-shared";
import { TaskNavigator } from "../screens/session/TaskNavigator";
import { withQuery, type RouteQuery } from "../router";

/** Shell-owned reads and DOM survive the selected task's loading state and route remount. */
export default function SessionNavigator({ id, query }: { id: string; query: RouteQuery }) {
  const { state } = useTaskContext();
  const history = useQuery<{ tasks: ApiTask[] }>("task.list", { all: true, limit: 20, ...(query.repo ? { repo: query.repo } : {}) }, "", true);
  const work = useQuery<{ tasks: WorkRow[] }>("dispatch.list", { relation: "all", limit: 100, ...(query.repo ? { repo: query.repo } : {}) }, "", true);
  const selected = useQuery<TaskDetail>("task.get", { id }, "", true);
  const detail = selected.data?.id === id ? [{ ...selected.data, parentId: selected.data.work?.parentId ?? null }] : [];
  const extra = [...workTasks(work.data?.tasks ?? []), ...(history.data?.tasks ?? []), ...detail];
  const now = Date.now() / 1000;
  const nodes = state.snapshot
    ? scopedTaskTree(state.snapshot, { repo: query.repo || null }, { now, extra, pinned: id })
    : taskTree({ tasks: extra.filter(item => !query.repo || item.repo?.key === query.repo) }, { now });
  return <TaskNavigator selectedId={id} nodes={nodes} query={withQuery("", query)} />;
}
