import { LazyWorkPanels } from "../../shell/panels/LazyWorkPanels";
import { useFrame } from "../../shell/slots";
import { useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Page } from "../../ds/Page";
import { Button } from "../../ds/Button";
import { TextInput } from "../../ds/Controls";
import { Icon } from "../../ds/icons";
import { Tabs } from "../../ds/Patterns";
import { SearchPicker } from "../../ds/SearchPicker";
import { TaskTree } from "../../ds/TaskTreeNode";
import type { TaskCardView } from "../../ds/TaskCard";
import type { TaskBucket, TaskNodeView } from "../../../../src/view-model/task-tree";
import { treeSummary } from "../../../../src/view-model/task-tree";
import type { RepoRef } from "../../../../src/api/read-model/types";
import { ResourceView } from "./Session";
import { useDelayedBusy, useTaskContext } from "../task-shared";
import { taskHeading } from "../../../../src/view-model/titles";
import { LazyTaskAside, LazyTaskBranch } from "./LazyTaskAside";
import { taskHref } from "./task-href";
import { withQuery, type RouteQuery } from "../../router";

type Filter = "all" | Exclude<TaskBucket, "other">;
const FILTERS: { value: Filter; label: string; dot?: string }[] = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs you", dot: "bad" }, { value: "running", label: "Running", dot: "info" },
  { value: "accepted", label: "Accepted", dot: "good" }, { value: "stopped", label: "Stopped" },
];
const PAGE = 20;
const matches = (node: TaskNodeView, needle: string): boolean => !needle
  || [node.title, node.branch ?? "", ...node.meta.map(item => item.text)].some(text => text.toLowerCase().includes(needle))
  || node.children.some(child => matches(child, needle));
const find = (nodes: TaskNodeView[], id: string | undefined): { node: TaskNodeView; parent?: TaskNodeView; index: number; siblings: number } | undefined => {
  for (const node of nodes) {
    if (node.id === id) return { node, index: 0, siblings: nodes.length };
    const index = node.children.findIndex(child => child.id === id);
    if (index >= 0) return { node: node.children[index]!, parent: node, index, siblings: node.children.length };
    const deeper = find(node.children, id);
    if (deeper) return deeper;
  }
};

export interface TasksPageProps {
  /** Every loaded root with its subtasks; undefined until the first snapshot. */
  nodes: TaskNodeView[] | undefined; repos: RepoRef[]; query: RouteQuery; onNew(): void;
  /** True when older tasks can still be fetched from the service. */
  hasOlder: boolean; loadingOlder: boolean; onLoadOlder(): void; error?: ComponentChildren;
  /** More work rows (subtask links, branches, tokens) than one page held. */
  updating?: boolean;
  hasMoreWork?: boolean; loadingMoreWork?: boolean; onLoadMoreWork?(): void;
}

/** The Tasks board: header, filters and the task tree beside the selected task. */
export function TasksPage({ nodes, repos, query, onNew, hasOlder, loadingOlder, onLoadOlder, error, hasMoreWork, loadingMoreWork, onLoadMoreWork, updating = false }: TasksPageProps) {
  const busy = useDelayedBusy(updating);
  const {state} = useTaskContext();
  const frame = useFrame();
  // The Inspector shows the selected task; the inline aside covers it only while the Inspector is closed.
  const showAside = frame?.inline !== false || !frame?.details?.open;
  const heading = (node: TaskNodeView) => state.snapshot?.tasks.find(task => task.id === node.id)?.title || taskHeading(node.title);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<string>();
  const roots = nodes ?? [];
  const counts = useMemo(() => {
    const total: Record<Filter, number> = { all: roots.length, needs: 0, running: 0, accepted: 0, stopped: 0 };
    for (const node of roots) if (node.bucket !== "other") total[node.bucket]++;
    return total;
  }, [roots]);
  const needle = search.trim().toLowerCase();
  const visible = roots.filter(node => (filter === "all" || node.bucket === filter) && matches(node, needle));
  const page = visible.slice(0, shown);
  const summary = treeSummary(roots, Date.now() / 1000);
  const sessionHref = taskHref(query.repo ? `repo=${encodeURIComponent(query.repo)}` : "");
  const href = (id: string) => { const node = find(roots,id)?.node; return node && node.bucket !== "running" ? withQuery(`#/tasks/${encodeURIComponent(id)}/trace`, query) : sessionHref(id); };
  const viewHref = (id: string, view: TaskCardView) => `${sessionHref(id)}${sessionHref(id).includes("?") ? "&" : "?"}tab=${view}`;
  // The panel follows the selection only while that task is still listed; a filter or search that hides it hands the panel to the first card.
  const here = find(page, selected) ?? (page[0] ? find(page, page[0].id) : undefined);
  const go = (repo: string | null) => { location.hash = withQuery(location.hash.split("?")[0] || "#/", { ...query, repo }); };
  const repoLabel = repos.find(repo => repo.key === query.repo)?.label ?? "All repos";
  return <><LazyWorkPanels query={query} selected={here?.node.id ?? null} /><Page width="full" aria-busy={busy || undefined} className={`pc-tasks-page${busy ? " pc-query-refreshing" : ""}`}>
    <header className="pc-tasks-page__header">
      <div className="pc-tasks-page__heading">
        <h1 className="pc-tasks-page__title">Tasks</h1>
        {nodes && <span className="pc-tasks-page__caption">{summary.roots} root task{summary.roots === 1 ? "" : "s"}{summary.period ? ` ${summary.period}` : ""} · {summary.subtasks} subtask{summary.subtasks === 1 ? "" : "s"}{` · ${summary.tokens ?? "— tokens"}`}</span>}
      </div>
      <label className="pc-tasks-page__search"><span className="sr-only">Search tasks</span><Icon name="overview" />
        <TextInput type="search" value={search} placeholder="Search goal, repo or branch" onInput={event => { setSearch(event.currentTarget.value); setShown(PAGE); }} />
      </label>
      {repos.length > 0 && <SearchPicker label={`${repoLabel} · ${repos.length}`} searchLabel="Search repositories" placeholder="Search repositories…" emptyLabel="No matching repositories."
        value={query.repo || null} onChange={go} options={[{ value: null, label: "All repos" }, ...repos.map(repo => ({ value: repo.key, label: repo.label, searchText: `${repo.label} ${repo.key}` }))]} />}
      <Button variant="primary" onClick={onNew}>New task</Button>
    </header>
    <Tabs label="Task filter" id="task-filter" value={filter} onChange={value => { setFilter(value as Filter); setShown(PAGE); }}
      options={FILTERS.map(item => ({ value: item.value, label: <>{item.dot && <span className={`pc-tasks-page__dot pc-tasks-page__dot--${item.dot}`} aria-hidden="true" />}{item.label} <span className="pc-tasks-page__count">{counts[item.value]}</span></> }))} />
    {error}
    <div className="pc-tasks-page__columns" role="tabpanel" id={`task-filter-${filter}-panel`} aria-labelledby={`task-filter-${filter}-tab`}>
      <section className="pc-tasks-page__tree" aria-label="Task tree">
        <ResourceView layout="list" value={nodes ? { data: page } : { loading: true }} loading="Loading tasks…" empty={needle || filter !== "all" ? "No tasks match." : "No tasks yet."}>
          {list => <TaskTree nodes={list} density="regular" href={href} viewHref={viewHref} heading={heading} renderBranch={node => node.branch ? <span className="pc-task-card__branch" title={node.branch}>{node.branch}</span> : <LazyTaskBranch id={node.id}/>} selectedId={here?.node.id} onSelect={setSelected} label="Tasks" />}
        </ResourceView>
        {nodes && roots.length > 0 && <div className="pc-tasks-page__more">
          <span className="pc-tasks-page__caption" role="status">Showing {Math.min(shown, visible.length)} of {visible.length} root tasks</span>
          {visible.length > shown ? <Button size="sm" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, visible.length - shown)} more</Button>
            : hasOlder ? <Button size="sm" busy={loadingOlder} onClick={onLoadOlder}>Load older tasks</Button>
            : hasMoreWork && <Button size="sm" busy={loadingMoreWork} onClick={onLoadMoreWork}>Load more subtasks</Button>}
        </div>}
      </section>
      {here && showAside && <LazyTaskAside key={here.node.id} node={here.node} parent={here.parent} position={here.parent ? `Subtask ${here.index + 1} of ${here.siblings}` : "Root task"} href={href} viewHref={viewHref} />}
    </div>
  </Page></>;
}
