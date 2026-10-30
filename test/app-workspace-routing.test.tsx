import { expect, test } from 'bun:test';
import { resolveRoute, routes, hrefFor } from '../app/src/router';
import { uiHref } from '../app/src/data/actions';
import { actionRoute } from '../app/src/tray/model';
import { workspaceTasks } from '../app/src/screens/workspace/Workspace';
import type { ClientTask } from '../src/view-model/snapshot';

test('task page replaces trace, result and failure destinations without losing scope',()=>{
 for(const suffix of ['trace','review','failure'])expect(resolveRoute(`#/tasks/a%20b/${suffix}?repo=api&scope=all`)).toEqual({redirect:'#/tasks/a%20b?repo=api&scope=all'});
 for(const target of [routes.task('a b'),routes.trace('a b'),routes.failure('a b'),routes.reviewTask('a b')])expect(hrefFor(target)).toBe('#/tasks/a%20b');
});
test('old task tabs select the matching workspace panel',()=>{
 for(const [tab,panel] of [['session','session'],['changes','changes'],['brief','notes']])expect(resolveRoute(`#/tasks/one?tab=${tab}&repo=api`)).toEqual({redirect:`#/workspace?task=one&panel=${panel}&repo=api`});
 expect(resolveRoute('#/terminal/one?repo=api')).toEqual({redirect:'#/workspace?task=one&repo=api'});
 expect(resolveRoute('#/workspace?task=one&panel=notes')).toMatchObject({name:'terminal',id:'one',panel:'notes'});
});
test('task titles and explicit session actions have distinct destinations',()=>{
 for(const view of ['task','review']){expect(uiHref({view,id:'one'})).toBe('#/tasks/one');expect(actionRoute({label:'Open',op:'ui.open',params:{view,id:'one'}})).toBe('/tasks/one');}
 expect(uiHref({view:'session',id:'one'})).toBe('#/workspace?task=one');
 expect(actionRoute({label:'Open',op:'ui.open',params:{view:'session',id:'one'}})).toBe('/workspace?task=one&panel=session');
});
test('workspace retains live tasks, recent results, tasks needing review, and selected history',()=>{
 const t=(id:string,state:string,updatedAt:number,extra={})=>({id,state,updatedAt,...extra}) as ClientTask;
 const rows=[t('live','running',1),t('answer','needs_input',1),t('recent','done',100000),t('review','done',1,{reviewRequest:{at:1,note:'Review'}}),t('old','done',1),t('selected','done',1)];
 expect(workspaceTasks(rows,100000,'selected').map(t=>t.id)).toEqual(['live','answer','recent','review','selected']);
});

test('recorded verdicts do not keep presenting a result as ready for review',async()=>{
 const {renderToString}=await import('preact-render-to-string');
 const {NowCard}=await import('../app/src/screens/trace/Overview');
 const {TaskContext}=await import('../app/src/screens/task-shared');
 const {initialState}=await import('../app/src/data/store');
 const fixture=(await import('./fixtures/ui/task-get.json')).default;
 for(const accepted of [true,false]){
  const task={...fixture,review:{accepted}} as unknown as import('../src/core/task-detail').TaskDetail;
  const html=renderToString(<TaskContext.Provider value={{state:initialState(),api:{} as never}}><NowCard task={task}/></TaskContext.Provider>);
  expect(html).toContain(accepted?'Result accepted':'Result rejected');
  expect(html).not.toContain('Ready for your review');
 }
});

test('running now-card uses the recorded phase and omits unavailable identity details',async()=>{
 const {renderToString}=await import('preact-render-to-string');
 const {NowCard}=await import('../app/src/screens/trace/Overview');
 const {TaskContext}=await import('../app/src/screens/task-shared');
 const {initialState}=await import('../app/src/data/store');
 const fixture=(await import('./fixtures/ui/task-get.json')).default;
 for(const [phase,word] of [['working','editing'],['testing','testing'],['idle','waiting']]) {
  const task={...fixture,state:'running',review:null,summary:'Unknown',executor:'codex#personal',progress:{phase,files:3},acceptance:{state:'pending'}} as unknown as import('../src/core/task-detail').TaskDetail;
  const html=renderToString(<TaskContext.Provider value={{state:initialState(),api:{} as never}}><NowCard task={task} compact/></TaskContext.Provider>);
  expect(html).toContain(`Codex is ${word} now`);
  expect(html).toContain('Codex · personal · 3 files touched so far · runs acceptance when it finishes');
  expect(html).not.toContain('Unknown');
 }
 const missing={...fixture,state:'running',review:null,executor:'unknown#unknown',attempts:[],cost:{executor:null},summary:'Unknown',acceptance:{state:'pending'}} as unknown as import('../src/core/task-detail').TaskDetail;
 const html=renderToString(<TaskContext.Provider value={{state:initialState(),api:{} as never}}><NowCard task={missing} compact/></TaskContext.Provider>);
 expect(html).toContain('The agent is editing now');
 expect(html).not.toContain('Unknown');
});
