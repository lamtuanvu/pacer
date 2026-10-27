import { SectionHeading } from "../../ds/SectionHeading";
import { TaskTree } from "../../ds/TaskTreeNode";
import type { TaskNodeView } from "../../../../src/view-model/task-tree";
import { ResourceView } from "./Session";
import type { Resource } from './types';
import { Page } from '../../ds/Page';
export interface SessionsListProps { running?:Resource<TaskNodeView[]>; recent?:Resource<TaskNodeView[]>; query?:string }
export const taskHref=(query='')=>(id:string)=>`#/tasks/${encodeURIComponent(id)}${query?(query.startsWith('?')?query:`?${query}`):''}`;
/** The caller builds both lists with scopedTaskTree; ordering and attention decisions live there, not here. */
export function SessionsList({running,recent,query=''}:SessionsListProps){
 const href=taskHref(query);
 return <Page width="full" embedded className="pc-sessions-list"><section className="pc-card-section" aria-label="Running"><div className="pc-card-section__head"><SectionHeading>Running</SectionHeading></div><ResourceView value={running} loading="Loading running sessions…" empty="No running sessions.">{nodes=><TaskTree nodes={nodes} density="regular" href={href} label="Running tasks"/>}</ResourceView></section><section className="pc-card-section" aria-label="Completed"><div className="pc-card-section__head"><SectionHeading>Completed</SectionHeading></div><ResourceView value={recent} loading="Loading task history…" empty="No completed tasks.">{nodes=><TaskTree nodes={nodes} density="regular" href={href} label="Completed tasks"/>}</ResourceView></section></Page>;
}
export default SessionsList;
