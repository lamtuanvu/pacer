import { Switch } from "../app/src/ds/Controls";
import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { ActionContext } from '../app/src/data/action-context';
import { createActionRunner } from '../app/src/data/actions';
import { Screen } from '../app/src/screens/Screen';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { resolveRoute, SETTINGS_SECTIONS, type Route } from '../app/src/router';
import { HostSessionSwitch } from '../app/src/screens/settings/HostSessionSwitch';
import { sessionDetail, sessionRow } from '../app/src/screens/session/controller';
import snapshot from './fixtures/ui/snapshot.json';
import detail from './fixtures/ui/task-get.json';
import type { TaskDetail } from '../src/core/task-detail';
const state={...initialState(),snapshot:snapshot as any};
function destination(hash:string):Route {
 let result=resolveRoute(hash);
 while('redirect' in result)result=resolveRoute(result.redirect);
 return result;
}
const runner=createActionRunner({call:async<T,>()=>({}) as T,waitFor:async()=>true,refetch:()=>{},navigate:()=>{}});
const html=(hash:string)=>renderToString(<TaskContext.Provider value={{state,api:{call:async()=>({})} as any}}><ActionContext.Provider value={runner}><Screen route={destination(hash)}/></ActionContext.Provider></TaskContext.Provider>);
test('shell mounts the U3 settings screens and U4 sessions screens',()=>{
 expect(html('#/settings')).toContain('Loading settings');
 for(const section of SETTINGS_SECTIONS) {
  const page=html(`#/settings/${section}`);
  expect(page).toContain('Loading settings');
  if(section!=='planner')expect(page).not.toContain('id="pacing"');
 }
 expect(html('#/settings/hosts')).toContain('Connect and check');
 expect(html('#/settings/hosts/devbox')).toContain('Remote hosts</a>');
 expect(html('#/settings/add-executor')).toContain('Step 1 of 4');
 expect(html('#/sessions')).toContain('Completed');
 expect(html('#/sessions/t1')).toContain('Loading task');
});
test('legacy and unknown routes mount the Dispatch home, which loads on demand',()=>{
 for(const path of ['/executors','/executors/add','/accounts','/strategy','/hosts','/missing']) {
  expect(destination(`#${path}`).name).toBe('dispatch');
  expect(html(`#${path}`)).toContain('<p role="status">Loading…</p>');
 }
 expect(html('#/needs-you')).toContain('<p role="status">Loading…</p>');
 expect(html('#/review/t1')).toContain('Loading task');
});
test('Add executor keeps the host prefill from host detail links',()=>{
 expect(destination('#/settings/add-executor?host=dev%20box')).toMatchObject({name:'add-executor',host:'dev box'});
 expect(html('#/settings/add-executor?host=devbox')).toContain('codex@devbox');
});
test('host full live sessions switch follows service capability and dispatches both host.set values',()=>{
 const calls:unknown[]=[];
 const run=(op:string,params:unknown)=>{calls.push([op,params]);};
 expect(HostSessionSwitch({alias:'devbox',host:{},run})).toBeNull();
 for(const [session,enabled] of [['recording',true],['full',false]] as const) {
  const node=HostSessionSwitch({alias:'devbox',host:{session},run})!;
  expect(node.type).toBe(Switch);
  expect(node.props.checked).toBe(session==='full');
  expect(node.props['aria-label']).toBe('Full live sessions');
  node.props.onChange!({currentTarget:{checked:enabled}} as any);
 }
 expect(calls).toEqual([['host.set',{alias:'devbox',session:'full'}],['host.set',{alias:'devbox',session:'recording'}]]);
 expect(renderToString(<HostSessionSwitch alias="devbox" host={{session:'full'}} run={run}/>)).toContain('role="switch"');
});
test('session adapter feeds the real brief, acceptance and timeline',()=>{
 const task=detail as unknown as TaskDetail;
 const row=sessionDetail(task);
 expect(row.id).toBe(task.id);
 expect(row.brief?.data).toContain(task.brief.goal);
 expect(row.doneWhen?.data).toBe(task.acceptance.cmd);
 expect(row.timeline?.data?.map(e=>e.text)).toEqual(task.timeline.map(e=>e.text));
 expect(sessionRow(task).repo).toBe(task.repo.label);
});

test("Setup mounts its own screen, loaded as its own chunk", () => { expect(html("#/setup")).toContain("Loading Setup"); });
