import { render } from 'preact';
import { useState } from 'preact/hooks';
import { SessionPanel, SessionFiles, SessionWorkspace, SessionInsights, SessionHeader, type SessionPanelTab } from '../../../app/src/screens/session/SessionPanel';
import { TaskNavigator } from '../../../app/src/screens/session/TaskNavigator';
import { taskTree } from '../../../src/view-model/task-tree';
import detail from './task-get.json';
import type { TaskDetail } from '../../../src/core/task-detail';
const task = { ...detail, id:'t-file', title:'Inspect the session file', state:'running', machine:'Local Mac', worktree:'~/work/api', base:'origin/main' } as TaskDetail;
const diff = { patch:'',untracked:['reports/demo.md','src/other.ts'],truncated:false };
function Fixture() {
 const [tab,setTab] = useState<SessionPanelTab>('details');
 const files = <SessionFiles id={task.id} diff={diff} onOpen/>;
 return <div className="pc-app pc-density--normal"><div className="pc-session-test-frame"><aside className="pc-side-panel pc-side-panel--left pc-side-panel--wide"><TaskNavigator selectedId={task.id} nodes={taskTree({tasks:[task,{...task,id:"child",parentId:task.id,title:"Child task"}]},{now:Date.now()/1000})}/></aside><div className="pc-task-workspace"><div className="pc-task-workspace__main"><SessionHeader task={task}/><div aria-label="Terminal fixture">Terminal remains mounted</div></div></div><aside className="pc-side-panel pc-side-panel--right"><div className="pc-side-panel__content"><SessionPanel id={task.id} tab={tab} onTab={setTab} count={2} changes={files} work={<section aria-label="Work tree fixture">Work tree</section>} details={<div className="pc-session-details"><SessionWorkspace task={task}/><SessionInsights task={task}/>{files}</div>} readFile={async reference=>{if(reference==='missing.ts')throw Error('File is missing');return {path:reference,kind:reference.endsWith('.md')?'markdown':'code',text:reference.endsWith('.md')?'# Session report\n\nThe viewer stays beside the terminal.':'export const ready = true;',size:58,modified:'2026-10-29T00:00:00Z'};}}/></div></aside></div></div>;
}
render(<Fixture/>,document.getElementById('root')!);
