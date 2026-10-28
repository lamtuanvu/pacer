import { useState } from "preact/hooks";
import type { TaskNodeView } from "../../../src/view-model/task-tree";
import { classNames } from "./classNames";
import { TaskCard, type TaskCardDensity, type TaskCardView } from "./TaskCard";

export type TaskTreeDensity = TaskCardDensity;
const contains = (node: TaskNodeView, id: string | undefined): boolean => !!id && node.children.some(child => child.id === id || contains(child, id));
/**
 * The list of root cards. Expansion is kept by task id, so it survives snapshot refreshes and reordering;
 * a root holding the selected task opens until the user closes it. Regular density draws the Tasks board card;
 * compact density draws the navigator row.
 */
export function TaskTree({ nodes, density, selectedId, href, label, viewHref, onSelect }: {
  nodes: TaskNodeView[]; density: TaskTreeDensity; selectedId?: string; href(id: string): string; label: string;
  viewHref?(id: string, view: TaskCardView): string; onSelect?(id: string): void;
}) {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const isExpanded = (node: TaskNodeView) => choices[node.id] ?? contains(node, selectedId);
  const toggle = (node: TaskNodeView) => (id: string) => setChoices(previous => ({ ...previous, [id]: !isExpanded(node) }));
  return <ul className={classNames("pc-task-tree", `pc-task-tree--${density}`)} aria-label={label}>{nodes.map(node => <li key={node.id}>
    <TaskCard density={density} node={node} expanded={isExpanded(node)} onToggle={toggle(node)} selectedId={selectedId} href={href} viewHref={viewHref} onSelect={onSelect} />
  </li>)}</ul>;
}
