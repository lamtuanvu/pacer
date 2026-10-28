import {expect, test} from 'bun:test';
import {chromium} from 'playwright-core';
import {renderToString} from 'preact-render-to-string';
import {SessionsList} from '../app/src/screens/session/SessionsList';
import {TaskNavigator} from '../app/src/screens/session/TaskNavigator';
import {TaskDetailFrame} from '../app/src/screens/TaskResult';
import {Session} from '../app/src/screens/session/Session';
import type {TaskDetail} from '../src/core/task-detail';
import type {SessionData} from '../app/src/screens/session/types';
import detailFixture from './fixtures/ui/task-get.json';
import sessionFixture from './fixtures/ui/session.json';
import {NarrowContext} from '../app/src/ds/Density';
import {Page} from '../app/src/ds/Page';
import {taskTree} from '../src/view-model/task-tree';
const view=(t:ClientTask)=>taskTree({tasks:[t]},{now:Math.floor(Date.now()/1000)})[0]!;
import {Sessions} from '../app/src/screens/session/controller';
import {Layout} from '../app/src/shell/Layout';
import {TaskContext} from '../app/src/screens/task-shared';
import {initialState} from '../app/src/data/store';
import type {StoreState} from '../app/src/data/store';
import type {BrowserApi} from '../app/src/data/api';
import type {ClientTask} from '../src/view-model/snapshot';

const task = {id:'ended',title:'Implement ticket SFOS-488…',fullTitle:'Implement ticket SFOS-488 (ZDD-A3) in the infrastructure repository',goal:'Implement ticket',state:'done',executor:'codex',backend:null,worktree:null,updatedAt:Math.floor(Date.now()/1000),repo:{label:'terastor/storfabricos-infra'}} as ClientTask;

test('Tasks rows open the task directly without repeated control actions',()=>{
 const html=renderToString(<SessionsList recent={{data:[view(task)]}}/>);
 expect(html).toContain(`>${task.fullTitle}</a>`);
 expect(html).toContain(`title="${task.fullTitle}"`);
 expect(html).toContain(`href="#/tasks/ended"`);
 expect(html).not.toContain('Take over');
 expect(html).not.toContain('View result');
 expect(view({...task,fullTitle:undefined}).title).toBe(task.title!);
});

test('Task navigator identifies the selected task and preserves the repo filter',()=>{
 const selected=view({...task,id:'running-task',state:'running',fullTitle:'Run a long task'});
 const html=renderToString(<TaskNavigator selectedId={selected.id} nodes={[selected,view(task)]} query='?repo=lamtuanvu%2Fpacer'/>);
 expect(html).toContain('pc-task-node--compact');
 expect(html).toContain('aria-label="Task navigator"');
 expect(html).toContain('aria-current="page"');
 expect(html).toContain('href="#/tasks/running-task?repo=lamtuanvu%2Fpacer"');
 expect(html).toContain('href="#/tasks/ended?repo=lamtuanvu%2Fpacer"');
 expect(html).not.toContain('All tasks');
});

const browserPath=process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('Tasks route follows Overview full-width gutters and card sections',async()=>{
 const fixture=(await import('./fixtures/ui/snapshot.json')).default;
 const state={...initialState(),connected:true,features:{readModel:true,ops:new Set<string>()},snapshot:fixture};
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/session/session.css'].map(f=>Bun.file(f).text()))).join('\n');
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try{
  const page=await browser.newPage();
  for(const width of [1990,1440]){
   await page.setViewportSize({width,height:1000});
   const html=renderToString(<TaskContext.Provider value={{state:state as unknown as StoreState,api:{} as BrowserApi}}><Layout route={{name:'sessions',query:{repo:null,scope:null}}} state={state as unknown as StoreState} title="Tasks"><Sessions query={{repo:null,scope:null}}/></Layout></TaskContext.Provider>);
   await page.setContent(`<html data-pacer-desktop data-pacer-native-titlebar><style>${css}</style><div id="app">${html}</div></html>`);
   const edges=await page.evaluate(()=>{
    const left=(selector:string)=>document.querySelector(selector)!.getBoundingClientRect().left;
    return [left('.pc-filter'),left('.pc-sessions-list'),left('.pc-sessions-list > section')];
   });
   expect(Math.max(...edges)-Math.min(...edges)).toBeLessThan(1);
   expect(edges[0]).toBeLessThan(100);
   expect(await page.locator('.pc-sessions-list > .pc-card-section').count()).toBe(2);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
 }finally{await browser.close();}
});
test.skipIf(!browserPath)('Tasks bounds whole-row links and metadata inside narrow viewports',async()=>{
 const longTitle='Implement ticket SFOS-488 (ZDD-A3) across the deployment controller, rollback checks, migration report, and all affected infrastructure integration tests';
 const longRepo='terastor/storfabricos-infrastructure-deployment-controller-and-validation';
 const runningTask=view({...task,id:'running-long',state:'running',fullTitle:longTitle,repo:{...task.repo!,label:longRepo}} as ClientTask);
 const failedTask=view({...task,id:'failed-long',state:'failed',fullTitle:'Retry budget refresh after a transient provider outage and verify each affected account'});
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/session/session.css'].map(f=>Bun.file(f).text()))).join('\n');
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try{
  const page=await browser.newPage();
  for(const width of [1990,1440,375])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:1000});
   await page.setContent(`<html data-theme="${theme}"><style>${css}</style>${renderToString(<NarrowContext.Provider value={width<560}><Page width="full" className="pc-page-body"><SessionsList running={{data:[runningTask]}} recent={{data:[view(task),failedTask]}}/></Page></NarrowContext.Provider>)}</html>`);
   if(process.env.PACER_LAYOUT_EVIDENCE)await page.screenshot({path:`${process.env.PACER_LAYOUT_EVIDENCE}/tasks-${width}-${theme}.png`});
   const geometry=await page.locator('.pc-sessions-list').evaluate(n=>({width:n.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}));
   if(width>560)expect(geometry.width).toBeGreaterThan(width-150);
   expect(geometry.overflow).toBe(false);
   const boxes=await page.locator('.pc-task-node,.pc-task-node__title,.pc-task-node__facts,.pc-meta-row__item').evaluateAll(nodes=>nodes.map(n=>({left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width})));
   for(const box of boxes){expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(width);expect(box.width).toBeGreaterThan(0);}
   expect(await page.locator('.pc-task-node__title').first().getAttribute('title')).toBe(longTitle);
   if(width<1440)expect(await page.locator('.pc-task-node__title').first().evaluate(n=>n.scrollWidth>n.clientWidth)).toBe(true);
   expect(await page.locator('.pc-meta-row__item').first().getAttribute('title')).toBe(longRepo);
   expect(await page.locator('.pc-task-node').count()).toBe(3);
   expect(await page.locator('.pc-task-node button').count()).toBe(0);
  }
 }finally{await browser.close();}
});

test.skipIf(!browserPath)('Dispatch clips long titles, keeps the composer to one row until focus and stays contained on desktop and phone',async()=>{
 const {DispatchView}=await import('../app/src/screens/dispatch/Dispatch');
 const {StartWork}=await import('../app/src/screens/StartSession');
 const {TaskContext}=await import('../app/src/screens/task-shared');
 const {createActionRunner}=await import('../app/src/data/actions');
 const {initialState}=await import('../app/src/data/store');
 const {Layout}=await import('../app/src/shell/Layout');
 const fixture=(await import('./fixtures/ui/snapshot.json')).default;
 const long='Implement ticket SFOS-488: '+'Complete the deployment-target implementation and verify all affected infrastructure. '.repeat(12);
 const snapshot={...fixture,tasks:fixture.tasks.map((t,i)=>i===0||t.id==='t-0409'?{...t,fullTitle:long}:t)};
 const state={...initialState(),connected:true,features:{readModel:true,ops:new Set<string>(["session.create"])},snapshot};
 const runner=createActionRunner({call:async<T,>()=>({} as T),waitFor:async()=>true,refetch(){},navigate(){}});
 const summary={rootTasksHandled:12,acceptedFirstTry:9,reviewedRoots:11,acceptedFirstTryRate:9/11,retryAttempts:2,tokens:{total:1_840_000,measuredAttempts:4,partialAttempts:1,unknownAttempts:1,attempts:6,lowerBound:true},spread:[{agent:'codex',total:980_000,tasks:4},{agent:'claude-code',total:520_000,tasks:6},{agent:'agy',total:340_000,tasks:2}],planner:{coverage:'unknown' as const},ranOutsidePlanner:null,previous:{rootTasksHandled:10}};
 const insights={supported:true,loading:false,current:summary,today:summary};
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css'].map(f=>Bun.file(f).text()))).join('\n');
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try{
  const page=await browser.newPage();
  for(const width of [1990,1440,375])for(const theme of ['light','dark'])for(const withTokens of [false,true]){
   await page.setViewportSize({width,height:1200});
   const query={repo:null,scope:width<560?'repo:github.com/acme/api':null};
   const html=renderToString(<TaskContext.Provider value={{state:state as unknown as StoreState,api:{} as BrowserApi}}><Layout route={{name:'dispatch',query}} state={state as unknown as StoreState} title="Dispatch"><DispatchView snapshot={snapshot as never} query={query} now={snapshot.at} runner={runner} routing={null} insights={withTokens?insights:undefined} onPeriod={()=>{}} startWork={<StartWork/>}/></Layout></TaskContext.Provider>);
   await page.setContent(`<html data-theme="${theme}" data-pacer-desktop data-pacer-native-titlebar><div id="app"><style>${css}</style>${html}</div></html>`);
   if(process.env.PACER_LAYOUT_EVIDENCE)await page.screenshot({path:`${process.env.PACER_LAYOUT_EVIDENCE}/dispatch-${width}-${theme}${withTokens?'-insights':''}.png`,fullPage:true});
   const titles=page.locator('.pc-task-node__title',{hasText:'Implement ticket SFOS-488'});
   expect(await titles.count()).toBeGreaterThan(0);
   for(const title of await titles.all()){
    expect(await title.getAttribute('title')).toBe(long);
    expect(await title.evaluate(n=>({clipped:n.scrollWidth>n.clientWidth,overflow:getComputedStyle(n).textOverflow}))).toEqual({clipped:true,overflow:'ellipsis'});
   }
   // Collapsed composer: the request only; repository and agent fields appear once it has focus.
   expect(await page.locator('.pc-start-composer textarea').count()).toBe(1);
   expect(await page.locator('.pc-start-fields').count()).toBe(0);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const contentEdge=await page.locator('.pc-dispatch h1').evaluate(n=>n.getBoundingClientRect().left);
   expect(contentEdge).toBe(width<560?16:72);
   if(withTokens){
    const bar=page.locator('.pc-share-bar__bar');
    expect(await bar.getAttribute('role')).toBe('img');
    const box=await bar.boundingBox();
    expect(box!.width).toBeGreaterThan(100);
    expect(await page.locator('.pc-share-bar__legend tbody tr').count()).toBe(3);
    expect(await page.locator('.pc-share-bar__legend').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
    // Every region keeps its own height: the token share and Needs you do not stretch to match each other.
    if(width>=560){const [share,needs]=await Promise.all(['.pc-dispatch-spread','.pc-dispatch-attention'].map(s=>page.locator(s).evaluate(n=>n.getBoundingClientRect().height)));
    expect(share).not.toBe(needs);}
   }
  }
 }finally{await browser.close();}
});

test.skipIf(!browserPath)('opened task gives the live session the main pane and retains Tasks navigation',async()=>{
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/session/session.css'].map(f=>Bun.file(f).text()))).join('\n');
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try{
  const page=await browser.newPage();
  for(const width of [1440,375])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:900});
   const fixture=(await import('./fixtures/ui/snapshot.json')).default;
   const state={...initialState(),connected:true,features:{readModel:true,ops:new Set<string>()},snapshot:fixture};
   const runningTask={...detailFixture,id:sessionFixture.id,title:sessionFixture.goal,goal:sessionFixture.goal,state:'running',endedAt:undefined,repo:{...detailFixture.repo,label:sessionFixture.repo}} as unknown as TaskDetail;
   const runningSession={...sessionFixture,phase:undefined,stop:undefined} as SessionData;
   const content=<TaskDetailFrame task={runningTask} query={{repo:null,scope:null}} tab="session" onTab={()=>{}} navigator={<TaskNavigator selectedId={runningTask.id} nodes={taskTree({tasks:[runningTask]},{now:Date.now()/1000})}/> }><Session embedded view="terminal" data={runningSession}/></TaskDetailFrame>;
   const html=renderToString(<TaskContext.Provider value={{state:state as unknown as StoreState,api:{} as BrowserApi}}><Layout route={{name:'sessions',id:'t-0412',query:{repo:null,scope:null}}} state={state as unknown as StoreState} title="Task">{content}</Layout></TaskContext.Provider>);
   await page.setContent(`<html data-theme="${theme}"><style>${css}</style>${html}</html>`);
   if(process.env.PACER_LAYOUT_EVIDENCE)await page.screenshot({path:`${process.env.PACER_LAYOUT_EVIDENCE}/task-detail-${width}-${theme}.png`});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const nav=page.locator('.pc-task-nav');
   expect(await nav.isVisible()).toBe(width>767);
   const frame=await page.locator('.pc-session-layout').boundingBox();
   expect(frame).not.toBeNull();
   expect(frame!.width).toBeGreaterThan(width>767?width*0.65:width*0.8);
  }
 }finally{await browser.close();}
});
