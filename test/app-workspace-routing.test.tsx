import { expect, test } from 'bun:test';
import { resolveRoute, routes, hrefFor } from '../app/src/router';
import { uiHref } from '../app/src/data/actions';
import { actionRoute } from '../app/src/tray/model';
import { workspaceTasks, workspaceTaskNodes } from '../app/src/screens/workspace/Workspace';
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
 for(const view of ['task','review']){expect(uiHref({view,id:'one'})).toBe('#/tasks/one');expect(actionRoute({label:'Open',op:'ui.open',params:{view,id:'one'}})).toBe('/sessions/one');}
 expect(uiHref({view:'task',id:'one',tab:'answer'})).toBe('#/tasks/one?tab=answer');
 expect(actionRoute({label:'Answer',op:'ui.open',params:{view:'task',id:'one',tab:'answer'}})).toBe('/sessions/one/answer');
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

test('unrecognized progress phases retain the Tasks state vocabulary',async()=>{
 const {taskStatus}=await import('../src/view-model/words');
 expect(taskStatus({state:'running',progress:{phase:'executor-specific-phase'}}).label).toBe('Working');
 expect(taskStatus({state:'running',progress:{phase:'testing'}}).label).toBe('Testing');
});

test('workspace roots use the Tasks child-attention rollup',async()=>{
 const {workspaceTaskNodes}=await import('../app/src/screens/workspace/Workspace');
 const tasks=[{id:'root',goal:'Root',state:'running',executor:null,updatedAt:100},{id:'child',goal:'Child',state:'failed',executor:'codex',updatedAt:100}] as ClientTask[];
 const work:import('../src/view-model/task-tree').WorkRow[]=tasks.map((t,n)=>({id:t.id,parentId:n?'root':null,rootId:'root',depth:n,title:t.goal,state:t.state,executor:t.executor,rev:1}));
 work[1]!.tokens={total:12000,measuredAttempts:1,partialAttempts:0,lowerBound:false};
 const nodes=workspaceTaskNodes(tasks,work,undefined,100);
 expect(nodes).toHaveLength(1);
 expect(nodes[0]?.children.map(n=>n.id)).toEqual(['child']);
 expect(nodes[0]?.attention).toBe('bad');
 expect(nodes[0]?.attentionLabel).toBe('Subtask: Failed');
 expect(nodes[0]?.tokens).toBe('12k tokens');
});

test('editor handoff preserves file locations and escapes URI delimiters',async()=>{
 const {workspaceEditorHref}=await import('../app/src/screens/workspace/Workspace');
 const file={path:'src/a #b.ts',line:4,column:2} as import('../src/session/files').SessionFileResult;
 expect(workspaceEditorHref('/tmp/work tree',file)).toBe('vscode://file/tmp/work%20tree/src/a%20%23b.ts:4:2');
});

test('primary task links open an exact workspace and preserve scope',async()=>{
 const {taskHref:rowHref}=await import('../app/src/screens/session/task-href');
 const {taskHref}=await import('../app/src/model/tasks');
 expect(rowHref('repo=api&scope=all')('a /b')).toBe('#/workspace?task=a%20%2Fb&repo=api&scope=all');
 expect(taskHref('a /b')).toBe('#/workspace?task=a%20%2Fb');
});

test('stopped results and absent acceptance never promise review or checks',async()=>{
 const {renderToString}=await import('preact-render-to-string');
 const {NowCard,Acceptance}=await import('../app/src/screens/trace/Overview');
 const fixture=(await import('./fixtures/ui/task-get.json')).default;
 const task={...fixture,state:'stopped',review:null,brief:{...fixture.brief,acceptance:''},acceptance:{state:'none'},derived:{files:'unavailable'}} as unknown as import('../src/core/task-detail').TaskDetail;
 const html=renderToString(<><NowCard task={task} compact/><Acceptance task={task}/></>);
 expect(html).toContain('Task stopped');expect(html).not.toContain('Ready for your review');
 expect(html).toContain('No automatic checks configured');expect(html).not.toContain('Runs when the session ends');
});

test('queued workspace explains the recorded wait and the next step',async()=>{
 const {workspaceWait}=await import('../app/src/screens/workspace/Workspace');
 const fixture=(await import('./fixtures/ui/task-get.json')).default;
 expect(workspaceWait({...fixture,state:'queued',queue:{reason:'paused'}} as never)).toEqual({reason:'Delegation is paused.',next:'Resume delegation from Dispatch to let this task start.'});
 expect(workspaceWait({...fixture,state:'queued',queue:null} as never).reason).toBe('Waiting for an executor to start this task.');
});

test('compact metrics show one unavailable message rather than fabricated zeros',async()=>{
 const {renderToString}=await import('preact-render-to-string');
 const {CostTiles}=await import('../app/src/screens/trace/Overview');
 const fixture=(await import('./fixtures/ui/task-get.json')).default;
 const html=renderToString(<CostTiles task={{...fixture,attempts:[],tokens:undefined,derived:{files:'unavailable'}} as never} compact/>);
 expect(html).not.toContain('>0<');
 expect(html.match(/Some task metrics are unavailable/g)).toHaveLength(1);
});

test('an ended primary with a live added agent stays in the active task tree',()=>{
 const tasks=[{id:'parent',goal:'Existing task',state:'done',activeAgentSessions:2,executor:'codex',updatedAt:1}] as ClientTask[];
 const nodes=workspaceTaskNodes(tasks,[],undefined,100000);
 expect(nodes[0]).toMatchObject({active:true,state:{live:true,label:'Working'}});
});
