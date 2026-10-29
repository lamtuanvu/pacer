import {expect,test} from 'bun:test';
import {renderToString} from 'preact-render-to-string';
import { DispatchView } from "../app/src/screens/dispatch/Dispatch";
import {SessionsList} from './fixtures/ui/sessions-list';
import {taskTree} from '../src/view-model/task-tree';
import {createActionRunner} from '../app/src/data/actions';
import snapshot from './fixtures/ui/snapshot.json';
import fixture from './fixtures/ui/session.json';
import type {ClientSnapshot} from '../src/view-model/snapshot';
import type {SessionData} from '../app/src/screens/session/types';

test('Dispatch and Tasks open running sessions directly without takeover controls',()=>{
 const runner=createActionRunner({call:async<T,>()=>({} as T),navigate:()=>{},refetch:()=>{},waitFor:async()=>true});
 const html=renderToString(<DispatchView snapshot={snapshot as unknown as ClientSnapshot} query={{repo:null,scope:null}} now={snapshot.at} runner={runner}/>);
 for(const task of snapshot.tasks.filter(t=>t.state==='running'))expect(html).toContain(`href="#/tasks/${task.id}"`);
 expect(html).not.toContain('Take over');
 const list=renderToString(<SessionsList running={{data:taskTree({tasks:[{id:'t-0415',goal:(fixture as SessionData).goal,state:'running',executor:'codex',backend:null,worktree:null,updatedAt:1}]},{now:2})}}/>);
 expect(list).toContain('href="#/tasks/t-0415"');
 expect(list).not.toContain('Take over');
});
