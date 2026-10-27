import type { ComponentChildren } from "preact";
import { useId, useState } from "preact/hooks";
import type { TaskNodeView } from "../../../src/view-model/task-tree";
import { AgentStack } from "./AgentStack";
import { Button } from "./Button";
import { classNames } from "./classNames";
import { HostChip } from "./HostChip";
import { Icon } from "./icons";
import { MetaRow } from "./MetaRow";
import { Pill } from "./Pill";
import { StatusDot } from "./StatusDot";

export type TaskTreeDensity = "regular" | "compact";
export interface TaskTreeNodeProps {
  node: TaskNodeView; density: TaskTreeDensity; expanded: boolean; onToggle(id: string): void; selectedId?: string; href(id: string): string;
  /** Secondary actions for the card (Needs you, Live dispatch); siblings of the title link, never inside it. */
  actions?: ComponentChildren;
}

const contains = (node: TaskNodeView, id: string | undefined): boolean => !!id && node.children.some(child => child.id === id || contains(child, id));
const plural = (n: number) => `${n} subtask${n === 1 ? "" : "s"}`;

function ChildRows({ nodes, selectedId, href, id }: { nodes: TaskNodeView[]; selectedId?: string; href(id: string): string; id?: string }) {
  return <ul className="pc-task-node__children" id={id}>{nodes.map(child => <li key={child.id}>
    <a className={classNames("pc-task-node__child", child.id === selectedId && "pc-task-node__child--current")} href={href(child.id)}
      aria-current={child.id === selectedId ? "page" : undefined} title={child.title}>
      <span className="pc-task-node__child-title">{child.title}</span>
      {child.attention !== "none" && child.attentionLabel
        ? <Pill tone={child.attention}>{child.attentionLabel}</Pill>
        : <StatusDot tone={child.state.tone} live={child.state.live} label={child.state.label} />}
    </a>
    {child.children.length > 0 && <ChildRows nodes={child.children} selectedId={selectedId} href={href} />}
  </li>)}</ul>;
}

/** A root task card: status, title, attention, host, agents and facts, plus a toggle for its subtasks. Expansion is controlled by the caller. */
export function TaskTreeNode({ node, density, expanded, onToggle, selectedId, href, actions }: TaskTreeNodeProps) {
  const listId = `${useId()}-children`;
  const current = node.id === selectedId;
  return <article className={classNames("pc-task-node", `pc-task-node--${density}`, node.attention !== "none" && `pc-task-node--${node.attention}`, current && "pc-task-node--current")}>
    <div className="pc-task-node__head">
      <a className="pc-task-node__title" href={href(node.id)} aria-current={current ? "page" : undefined} title={node.title}>{node.title}</a>
      {/* The status label already says "Failed": repeating it in the pill would state one fact twice (UI-15). */}
      {node.attention !== "none" && node.attentionLabel && node.attentionLabel !== node.state.label && <Pill tone={node.attention}>{node.attentionLabel}</Pill>}
      {actions && <div className="pc-task-node__actions">{actions}</div>}
    </div>
    <div className="pc-task-node__facts">
      <StatusDot tone={node.state.tone} live={node.state.live} label={node.state.label} />
      {node.host && <HostChip name={node.host.name} kind={node.host.kind} />}
      {node.branch && <span className="pc-task-node__branch" title={node.branch}><Icon name="branch" /><span>{node.branch}</span></span>}
      <AgentStack agents={node.agents} size={density === "compact" ? 16 : 18} />
      {node.tokens && <span className="pc-task-node__tokens">{node.tokens}</span>}
    </div>
    {density === "regular" && <MetaRow items={node.meta} label="Task facts" />}
    {node.children.length > 0 && <>
      <Button variant="quiet" size="sm" className="pc-task-node__toggle" aria-expanded={expanded} aria-controls={listId}
        aria-label={`${plural(node.children.length)} of ${node.title}`} onClick={() => onToggle(node.id)}>
        <span className="pc-task-node__chevron" aria-hidden="true" />{plural(node.children.length)}
      </Button>
      {expanded && <ChildRows nodes={node.children} selectedId={selectedId} href={href} id={listId} />}
    </>}
  </article>;
}

/**
 * The list of root cards. Expansion is kept by task id, so it survives snapshot refreshes and reordering;
 * a root holding the selected task opens until the user closes it.
 */
export function TaskTree({ nodes, density, selectedId, href, label }: { nodes: TaskNodeView[]; density: TaskTreeDensity; selectedId?: string; href(id: string): string; label: string }) {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const isExpanded = (node: TaskNodeView) => choices[node.id] ?? contains(node, selectedId);
  return <ul className={classNames("pc-task-tree", `pc-task-tree--${density}`)} aria-label={label}>{nodes.map(node => <li key={node.id}>
    <TaskTreeNode node={node} density={density} expanded={isExpanded(node)} selectedId={selectedId} href={href}
      onToggle={id => setChoices(previous => ({ ...previous, [id]: !isExpanded(node) }))} />
  </li>)}</ul>;
}
