import { useEffect, useState } from "preact/hooks";
import { Button, IconButton } from "../../ds/Button";
import { AgentMark } from "../../ds/AgentMark";
import { useFrame } from "../../shell/slots";
import type { TaskNodeView } from '../../../../src/view-model/task-tree';
import { taskHref } from './task-href';

/** Compact session nodes keep the shared task vocabulary and navigation. */
function SessionNode({ node, selectedId, query, nested = false }: { node: TaskNodeView; selectedId: string; query: string; nested?: boolean }) {
 const contains = (item: TaskNodeView): boolean => item.id === selectedId || item.children.some(contains);
 const selected = contains(node);
 const [open, setOpen] = useState(selected);
 // Parent links can arrive after the snapshot; reveal the selected descendant once they do.
 useEffect(() => { if (selected) setOpen(true); }, [selectedId, selected]);
 return <div className="pc-session-node-group">
  <a className="pc-text-action pc-session-node" href={taskHref(query)(node.id)} aria-current={node.id === selectedId ? 'page' : undefined}>
   <span className="pc-session-node__title"><span className={`pc-session-node__dot pc-session-node__dot--${node.state.tone}`} aria-hidden="true"/><strong title={node.title}>{node.title}</strong>{nested && node.agents.map(agent => <AgentMark key={agent} agent={agent} size={16}/>)}</span>
   {!nested && <span className="pc-session-node__meta">{node.host && <span className="pc-session-node__host">{node.host.name}</span>}<span className="mono" title={node.repo}>{node.repo}</span></span>}
   <span className="pc-session-node__meta"><span className="pc-session-node__status">{node.attentionLabel ?? node.state.label}</span>{!nested && <span className="pc-session-node__agents">{node.agents.map(agent => <AgentMark key={agent} agent={agent} size={16}/>)}</span>}<span className="pc-session-node__tokens">{node.tokens?.replace(/ tokens$/, '') ?? "—"}</span></span>
  </a>
  {node.children.length > 0 && <><Button size="sm" variant="quiet" className="pc-session-node__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{node.children.length} {node.children.length === 1 ? 'subtask' : 'subtasks'}</Button>
   {open && <div className="pc-session-node__children">{node.children.map(child => <SessionNode key={child.id} node={child} selectedId={selectedId} query={query} nested/>)}</div>}</>}
 </div>;
}
export function TaskNavigator({selectedId,nodes,query=''}: { selectedId: string; nodes: TaskNodeView[]; query?: string }) {
 const panel = useFrame()?.sessions;
 return <nav className="pc-task-nav" aria-label="Task navigator"><div className="pc-task-nav__head"><strong>Sessions</strong>{panel && <IconButton id="pc-side-panel-left-toggle" size="sm" variant="quiet" icon="panel-left" aria-label="Hide Sessions" title="Hide Sessions" aria-expanded={panel.open} aria-controls="pc-side-panel-left" onClick={panel.toggle}/>}</div><div className="pc-task-nav__scroll">
  {nodes.map(node => <SessionNode key={node.id} node={node} selectedId={selectedId} query={query}/>)}
 </div></nav>;
}
