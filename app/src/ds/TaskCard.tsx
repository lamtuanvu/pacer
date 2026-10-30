import { taskHeading } from "../../../src/view-model/titles";
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import type { TaskNodeView } from "../../../src/view-model/task-tree";
import { AgentStack } from "./AgentStack";
import { classNames } from "./classNames";
import { HostChip } from "./HostChip";
import { Icon } from "./icons";
import { MetaRow } from "./MetaRow";
import { SubtaskToggle } from "./SubtaskToggle";
import { Pill } from "./Pill";

export type TaskCardView = "session" | "brief" | "changes";
export type TaskCardDensity = "regular" | "compact";
export interface TaskCardProps {
  density?: TaskCardDensity; node: TaskNodeView; expanded: boolean; onToggle(id: string): void; selectedId?: string; href(id: string): string;
  /** Where a row's quick actions go (Notes, Open terminal, Changes); regular density shows them when given. */
  viewHref?(id: string, view: TaskCardView): string; onSelect?(id: string): void;
  /** Buttons for the task (Take over, Stop on Dispatch); siblings of the title link, never inside it. */
  actions?: ComponentChildren;
  /** Borderless row inside a containing section, with lane dividers between rows. */
  flush?: boolean;
  renderBranch?(node: TaskNodeView): ComponentChildren;
  heading?(node: TaskNodeView): string;
}
const plural = (n: number) => `${n} subtask${n === 1 ? "" : "s"}`;
/** The dot's colour follows the card's attention first, then its status, so it never disagrees with the pill. */
const dotTone = (node: TaskNodeView) => node.attention !== "none" ? node.attention : node.state.tone;
/** A card that is no longer running still states its outcome in words, not only by the dot's colour. */
const settled = (node: TaskNodeView) => !node.active;
const words = (node: TaskNodeView) => node.attentionLabel ?? node.state.label;
const bare = (tokens?: string) => tokens?.replace(/ tokens$/, "");

function Dot({ node, size }: { node: TaskNodeView; size: "root" | "child" }) {
  return <span className={classNames("pc-task-card__dot", `pc-task-card__dot--${dotTone(node)}`, `pc-task-card__dot--${size}`, node.state.live && "pc-status-dot__dot--live")} aria-hidden="true" />;
}

function Children({ nodes, selectedId, href, id, onSelect, density, heading }: { nodes: TaskNodeView[]; selectedId?: string; href(id: string): string; id: string; onSelect?(id: string): void; density: TaskCardDensity; heading?(node: TaskNodeView): string }) {
  const regular = density === "regular";
  return <ul className="pc-task-card__children" id={id}>{nodes.map(child => <li key={child.id}>
    <a className={classNames("pc-task-card__child", child.id === selectedId && "pc-task-card__child--selected")} href={href(child.id)}
      aria-current={child.id === selectedId ? (regular ? "true" : "page") : undefined} onFocus={() => onSelect?.(child.id)} title={child.title}>
      <span className="pc-task-card__row">
        <Dot node={child} size="child" /><span className="sr-only">{words(child)}: </span>
        <span className="pc-task-card__child-title">{heading?.(child) || taskHeading(child.title)}</span>
        <AgentStack agents={child.agents} size={regular ? 18 : 16} />
        {regular && <span className="pc-task-card__tokens pc-task-card__tokens--child">{bare(child.tokens)}</span>}
      </span>
      <span className="pc-task-card__row pc-task-card__row--child-facts">
        {regular && child.host && <HostChip name={child.host.name} kind={child.host.kind} />}
        {regular && child.branch && <span className="pc-task-card__branch" title={child.branch}>{child.branch}</span>}
        <span className={classNames("pc-task-card__status", `pc-task-card__status--${dotTone(child)}`)}>{words(child)}</span>
        {!regular && <span className="pc-task-card__tokens pc-task-card__tokens--compact">{bare(child.tokens)}</span>}
      </span>
    </a>
    {child.children.length > 0 && <Children nodes={child.children} selectedId={selectedId} href={href} id={`${id}-${child.id}`} onSelect={onSelect} density={density} heading={heading} />}
  </li>)}</ul>;
}

/**
 * A root task as the Tasks and Session boards draw it. Regular: status dot, title, pill, then host, branch, agents,
 * tokens and quick actions, then facts. Compact (the navigator): title, host and repository, then status, agents and tokens.
 */
export function TaskCard({ density = "regular", node, expanded, onToggle, selectedId, href, viewHref, onSelect, actions, flush = false, renderBranch, heading: headingFor }: TaskCardProps) {
  const heading = headingFor?.(node) || taskHeading(node.title);
  const listId = `${useId()}-children`;
  const current = node.id === selectedId;
  const regular = density === "regular";
  const pill = !regular ? null : node.attention !== "none" && node.attentionLabel ? { tone: node.attention, label: node.attentionLabel }
    : settled(node) ? { tone: node.state.tone, label: node.state.label } : null;
  return <article className={classNames("pc-task-card", `pc-task-card--${density}`, flush && "pc-task-card--flush", node.attention !== "none" && `pc-task-card--${node.attention}`)}>
    <div className={classNames("pc-task-card__main", current && "pc-task-card__main--selected")} onClick={() => onSelect?.(node.id)}>
      <div className="pc-task-card__row pc-task-card__row--head">
        <Dot node={node} size="root" /><span className="sr-only">{words(node)}: </span>
        <a className="pc-task-card__title" href={href(node.id)} aria-current={current ? (regular ? "true" : "page") : undefined} title={node.title} onFocus={() => onSelect?.(node.id)}>{regular ? heading : node.title}</a>
        {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
        {regular && !pill && <span className={classNames("pc-task-card__status", `pc-task-card__status--${dotTone(node)}`)}>{node.state.label}</span>}
        {/* A flush row (Dispatch) carries its agents on the title line, as the board does. */}
        {flush && !regular && <AgentStack agents={node.agents} size={16} />}
        {actions && <span className="pc-task-card__controls">{actions}</span>}
      </div>
      {regular ? <div className="pc-task-card__row pc-task-card__row--facts">
        {node.host && <HostChip name={node.host.name} kind={node.host.kind} />}
        {renderBranch ? renderBranch(node) : <span className="pc-task-card__branch" title={node.branch}>{node.branch ?? "—"}</span>}
        <AgentStack agents={node.agents} size={18} />
        <span className="pc-task-card__tokens">{bare(node.tokens) ?? "—"}</span>
        {viewHref && <span className="pc-task-card__actions">
          <a className="pc-task-card__action" href={viewHref(node.id, "brief")} aria-label={`Notes for ${heading}`} title="Notes"><Icon name="notes" /></a>
          <a className="pc-task-card__action" href={viewHref(node.id, "session")} aria-label={`Open terminal for ${heading}`} title="Open terminal"><Icon name="terminal" /></a>
          <a className="pc-task-card__action" href={viewHref(node.id, "changes")} aria-label={`Changes for ${heading}`} title="Changes"><Icon name="branch" /></a>
        </span>}
      </div> : <>
        <div className="pc-task-card__row pc-task-card__row--facts">
          {node.host && <HostChip name={node.host.name} kind={node.host.kind} />}
          {node.repo && <span className="pc-task-card__branch pc-task-card__branch--repo" title="Repository">{node.repo}</span>}
        </div>
        <div className="pc-task-card__row pc-task-card__row--facts">
          <span className={classNames("pc-task-card__status pc-task-card__status--grow", `pc-task-card__status--${dotTone(node)}`)}>{words(node)}</span>
          {!flush && <AgentStack agents={node.agents} size={16} />}
          <span className="pc-task-card__tokens pc-task-card__tokens--compact">{bare(node.tokens) ?? "—"}</span>
        </div>
      </>}
      {regular && <MetaRow items={node.meta} label="Task facts" />}
    </div>
    {node.children.length > 0 && <>
      <div className="pc-task-card__kids"><SubtaskToggle aria-expanded={expanded} aria-controls={listId}
        aria-label={`${plural(node.children.length)} of ${heading}`} onClick={() => onToggle(node.id)}>
        {plural(node.children.length)}
      </SubtaskToggle></div>
      {expanded && <Children nodes={node.children} selectedId={selectedId} href={href} id={listId} onSelect={onSelect} density={density} heading={headingFor} />}
    </>}
  </article>;
}
