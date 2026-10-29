import {taskHeading} from "../src/view-model/titles";
import {expect, test} from 'bun:test';
import {chromium} from 'playwright-core';
import {renderToString} from 'preact-render-to-string';
import {SessionsList} from './fixtures/ui/sessions-list';
import {TaskNavigator} from '../app/src/screens/session/TaskNavigator';
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
 expect(html).toContain(`>${taskHeading(task.fullTitle!)}</a>`);
 expect(html).toContain(`title="${task.fullTitle}"`);
 expect(html).toContain(`href="#/tasks/ended"`);
 expect(html).not.toContain('Take over');
 expect(html).not.toContain('View result');
 expect(view({...task,fullTitle:undefined}).title).toBe(task.title!);
});

test('Task navigator identifies the selected task and preserves the repo filter',()=>{
 const selected=view({...task,id:'running-task',state:'running',fullTitle:'Run a long task'});
 const html=renderToString(<TaskNavigator selectedId={selected.id} nodes={[selected,view(task)]} query='?repo=lamtuanvu%2Fpacer'/>);
 expect(html).toContain('pc-session-node');
 expect(html).not.toContain('pc-task-card');
 expect(html).toContain('aria-label="Task navigator"');
 expect(html).toContain('aria-current="page"');
 expect(html).toContain('href="#/tasks/running-task?repo=lamtuanvu%2Fpacer"');
 expect(html).toContain('href="#/tasks/ended?repo=lamtuanvu%2Fpacer"');
 expect(html).not.toContain('All tasks');
});

const browserPath=process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('Tasks route lays out the board header, filters and tree inside the content width',async()=>{
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
   const geometry=await page.evaluate(()=>{
    const box=document.querySelector('.pc-tasks-page')!.getBoundingClientRect();
    return {title:document.querySelector('.pc-tasks-page__title')?.textContent,width:box.width,left:box.left,columns:getComputedStyle(document.querySelector('.pc-tasks-page__columns')!).display};
   });
   expect(geometry.title).toBe('Tasks');
   // Measured against the Tasks board: type, padding, card geometry and the quick-action size.
   const board=await page.evaluate(()=>{
    const style=(selector:string)=>{const el=document.querySelector(selector);return el?getComputedStyle(el):undefined;};
    const box=(selector:string)=>document.querySelector(selector)?.getBoundingClientRect();
    return {
     h1:[style('.pc-tasks-page__title')?.fontSize,style('.pc-tasks-page__title')?.lineHeight,style('.pc-tasks-page__title')?.fontWeight],
     page:[style('.pc-tasks-page')?.paddingTop,style('.pc-tasks-page')?.paddingLeft,style('.pc-tasks-page')?.paddingBottom,style('.pc-tasks-page')?.rowGap],
     search:[box('.pc-tasks-page__search')?.height,box('.pc-tasks-page__search')?.width],
     card:[style('.pc-task-card')?.borderRadius,style('.pc-task-card')?.paddingTop],
     main:[style('.pc-task-card__main')?.borderRadius,style('.pc-task-card__main')?.paddingTop,style('.pc-task-card__main')?.paddingLeft],
     title:[style('.pc-task-card__title')?.fontSize,style('.pc-task-card__title')?.lineHeight,style('.pc-task-card__title')?.fontWeight],
     dot:[box('.pc-task-card__dot--root')?.width,box('.pc-task-card__dot--root')?.height],
     host:[box('.pc-task-card .pc-host-chip')?.height],
     action:[box('.pc-task-card__action')?.width,box('.pc-task-card__action')?.height],
     aside:[box('.pc-task-aside')?.width,style('.pc-task-aside')?.position],
    };
   });
   expect(board).toEqual({h1:['28px','34px','650'],page:['24px','32px','40px','16px'],search:[36,260],card:['12px','4px'],main:['12px','10px','12px'],title:['14px','21px','600'],dot:[10,10],host:[22],action:[26,26],aside:[362,'sticky']});
   // Tasks rows use the board's 600 weight for both selected and unselected titles.
   expect(await page.locator('.pc-task-card__main:not(.pc-task-card__main--selected) .pc-task-card__title').first().evaluate(node=>getComputedStyle(node).fontWeight)).toBe('600');
   // The board fills the content area beside the 52px activity rail; the tree and aside share a row.
   expect(geometry.width).toBe(width-52);
   expect(geometry.left).toBeLessThan(100);
   expect(geometry.columns).toBe('flex');
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
   expect(geometry.overflow).toBe(false);
   const boxes=await page.locator('.pc-task-card,.pc-task-card__title,.pc-meta-row__item').evaluateAll(nodes=>nodes.map(n=>({left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width})));
   for(const box of boxes){expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(width);expect(box.width).toBeGreaterThan(0);}
   expect(await page.locator('.pc-task-card__title').first().getAttribute('title')).toBe(longTitle);
   if(width<1440)expect(await page.locator('.pc-task-card__title').first().evaluate(n=>n.scrollWidth>n.clientWidth)).toBe(true);
   expect(await page.locator('.pc-meta-row__item').first().getAttribute('title')).toBe(longRepo);
   expect(await page.locator('.pc-task-card').count()).toBe(3);
   expect(await page.locator('.pc-task-card button').count()).toBe(0);
  }
 }finally{await browser.close();}
});

test.skipIf(!browserPath)('Dispatch clips long titles, omits the composer and stays contained on desktop and phone',async()=>{
 const {DispatchView}=await import('../app/src/screens/dispatch/Dispatch');
 const {TaskContext}=await import('../app/src/screens/task-shared');
 const {createActionRunner}=await import('../app/src/data/actions');
 const {initialState}=await import('../app/src/data/store');
 const {Layout}=await import('../app/src/shell/Layout');
 const fixture=(await import('./fixtures/ui/snapshot.json')).default;
 const long='Implement ticket SFOS-488: '+'Complete the deployment-target implementation and verify all affected infrastructure. '.repeat(12);
 const snapshot={...fixture,tasks:fixture.tasks.map((t,i)=>i===0||t.id==='t-0409'?{...t,title:long,fullTitle:long}:t)};
 const state={...initialState(),connected:true,features:{readModel:true,ops:new Set<string>(["session.create"])},snapshot};
 const runner=createActionRunner({call:async<T,>()=>({} as T),waitFor:async()=>true,refetch(){},navigate(){}});
 const summary={rootTasksHandled:12,acceptedFirstTry:9,reviewedRoots:11,acceptedFirstTryRate:9/11,retryAttempts:2,tokens:{total:1_840_000,measuredAttempts:4,partialAttempts:1,unknownAttempts:1,attempts:6,lowerBound:true},spread:[{agent:'codex',total:980_000,tasks:4},{agent:'claude-code',total:520_000,tasks:6},{agent:'agy',total:340_000,tasks:2}],planner:{coverage:'unknown' as const},ranOutsidePlanner:null,previous:{rootTasksHandled:10}};
 const insights={supported:true,loading:false,current:summary,today:summary};
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/dispatch/dispatch.css'].map(f=>Bun.file(f).text()))).join('\n');
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try{
  const page=await browser.newPage();
  for(const width of [1990,1440,900,375])for(const theme of ['light','dark'])for(const withTokens of [false,true]){
   await page.setViewportSize({width,height:1200});
   const query={repo:null,scope:width<560?'repo:github.com/acme/api':null};
   const {NARROW_MEDIA,PANEL_MEDIA}=await import('../app/src/shell/narrow');
   const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
   Object.defineProperty(globalThis,'window',{configurable:true,value:{matchMedia:(q:string)=>({matches:q===NARROW_MEDIA?width<560:q===PANEL_MEDIA?width>=768:false})}});
   let html='';
   try{html=renderToString(<TaskContext.Provider value={{state:state as unknown as StoreState,api:{} as BrowserApi}}><NarrowContext.Provider value={width<560}><Layout route={{name:'dispatch',query}} state={state as unknown as StoreState} title="Dispatch"><DispatchView snapshot={snapshot as never} query={query} now={snapshot.at} runner={runner} routing={null} insights={withTokens?insights:undefined} onPeriod={()=>{}}/></Layout></NarrowContext.Provider></TaskContext.Provider>);}finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
   await page.setContent(`<html data-theme="${theme}" data-pacer-desktop data-pacer-native-titlebar><div id="app"><style>${css}</style>${html}</div></html>`);
   if(process.env.PACER_LAYOUT_EVIDENCE)await page.screenshot({path:`${process.env.PACER_LAYOUT_EVIDENCE}/dispatch-${width}-${theme}${withTokens?'-insights':''}.png`,fullPage:true});
   const titles=page.locator('.pc-dispatch-decision__task>strong',{hasText:'Implement ticket SFOS-488'});
   expect(await titles.count()).toBeGreaterThan(0);
   for(const title of await titles.all()){
    expect(await title.getAttribute('title')).toBe(long);
    expect(await title.evaluate(n=>({clipped:n.scrollWidth>n.clientWidth,overflow:getComputedStyle(n).textOverflow}))).toEqual({clipped:true,overflow:'ellipsis'});
   }
   // Dispatch uses the board ledger; new work is opened from the shell.
   expect(await page.locator('.pc-start-composer textarea').count()).toBe(0);
   expect(await page.locator('.pc-start-fields').count()).toBe(0);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const contentEdge=await page.locator('.pc-dispatch h1').evaluate(n=>n.getBoundingClientRect().left);
   expect(contentEdge).toBe(width<560?16:52+32);
   if(width>=560){
    expect(await page.locator(".pc-dispatch").evaluate(n=>{const s=getComputedStyle(n);return [s.paddingTop,s.paddingRight,s.paddingBottom,s.gap,s.maxWidth]})).toEqual(["24px","32px","40px","20px","none"]);
    expect(await page.locator(".pc-filter--menu .pc-search-picker>.pc-btn").evaluate(n=>[getComputedStyle(n).borderRadius,n.getBoundingClientRect().height])).toEqual(["8px",28]);
   }
   expect(await page.locator(".pc-live-dot").first().evaluate(n=>[n.getBoundingClientRect().width,n.getBoundingClientRect().height])).toEqual([8,8]);
   expect(await page.locator(".pc-attn-card").first().evaluate(n=>{const s=getComputedStyle(n);return [s.padding,s.borderRadius,s.gap,s.fontSize,s.lineHeight]})).toEqual(["12px","10px","10px","13px","19px"]);
   expect(await page.locator(".pc-live-dispatch>.pc-card-section__head").evaluate(n=>{const s=getComputedStyle(n);return [s.padding,s.gap]})).toEqual(["14px 20px","12px"]);
   expect(await page.locator(".pc-dispatch-decision").first().evaluate(n=>{const s=getComputedStyle(n);return [s.borderTopWidth,s.borderRadius,s.backgroundColor]})).toEqual(["1px","0px","rgba(0, 0, 0, 0)"]);
   expect(await page.locator(".pc-dispatch-decision").first().evaluate(n=>getComputedStyle(n).padding)).toBe("9px 20px");
   if(await page.locator(".pc-dispatch-decision").count()>1)expect(await page.locator(".pc-dispatch-ledger li+li>.pc-dispatch-decision").first().evaluate(n=>getComputedStyle(n).borderTopWidth)).toBe("1px");
   const rail=await page.locator(width<560?'.pc-bottom-bar':'.pc-rail').evaluate(n=>n.getBoundingClientRect().left);
   expect(rail).toBeGreaterThanOrEqual(0);
   if(withTokens){
    const bar=page.locator('.pc-dispatch-share');
    expect(await bar.getAttribute('role')).toBe('img');
    const box=await bar.boundingBox();
    expect(box!.width).toBeGreaterThan(100);
    expect(await page.locator('.pc-dispatch-share-table tbody tr').count()).toBe(3);
    // Tile dividers are drawn per tile, so a short last row leaves blank cells rather than a grey slab.
    expect(await page.locator('.pc-glance').evaluate(n=>getComputedStyle(n).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    expect(await page.locator('.pc-dispatch-share-table').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
    // Every region keeps its own height: the token share and Needs you do not stretch to match each other.
    if(width>=560){
     const natural=await page.locator(".pc-dispatch-attention").evaluate(n=>{const s=getComputedStyle(n);return {height:n.getBoundingClientRect().height,content:[...n.children].reduce((sum,c)=>sum+c.getBoundingClientRect().height,0)+parseFloat(s.gap)*(n.children.length-1)}});
     expect(natural.height).toBeCloseTo(natural.content,0);
    }
   }
  }
 }finally{await browser.close();}
},30_000); // Sixteen browser renders: four widths, two themes, with and without insights.




test.skipIf(!browserPath)('Needs you has one visible page h1 and space between repository context and the section', async()=>{
 const {NeedsYouPage}=await import('../app/src/screens/dispatch/Dispatch');
 const {ActionContext}=await import('../app/src/data/action-context');
 const {createActionRunner}=await import('../app/src/data/actions');
 const fixture=(await import('./fixtures/ui/snapshot.json')).default;
 const state={...initialState(),connected:true,features:{readModel:true,ops:new Set<string>()},snapshot:fixture} as unknown as StoreState;
 const runner=createActionRunner({call:async<T,>()=>({} as T),waitFor:async()=>true,refetch(){},navigate(){}});
 const query={repo:null,scope:null};
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/dispatch/dispatch.css'].map(f=>Bun.file(f).text()))).join('\n');
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try{
  const page=await browser.newPage();
  for(const width of [1440,900,375])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:900});
   const {NARROW_MEDIA,PANEL_MEDIA}=await import('../app/src/shell/narrow');
   // The shell picks its narrow frame from matchMedia; server rendering has none, so give it this width's answer.
   const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
   Object.defineProperty(globalThis,'window',{configurable:true,value:{matchMedia:(q:string)=>({matches:q===NARROW_MEDIA?width<560:q===PANEL_MEDIA?width>=768:false})}});
   let html='';
   try{html=renderToString(<ActionContext.Provider value={runner}><TaskContext.Provider value={{state,api:{} as BrowserApi}}><NarrowContext.Provider value={width<560}><Layout route={{name:'review',query}} state={state} title="Needs you"><NeedsYouPage query={query}/></Layout></NarrowContext.Provider></TaskContext.Provider></ActionContext.Provider>);}finally{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
   await page.setContent(`<html data-theme="${theme}"><style>${css}</style>${html}</html>`);
   expect(await page.locator('h1').count()).toBe(1);
   expect(await page.locator('h1').innerText()).toBe('Needs you');
   expect(await page.locator('h1').evaluate(n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n);return b.width>1&&b.height>1&&s.visibility==='visible'&&s.display!=='none'})).toBe(true);
   expect(await page.locator('.pc-needs-you').evaluate(n=>n.querySelector('.pc-section')!.getBoundingClientRect().top-n.querySelector('.pc-filter')!.getBoundingClientRect().bottom)).toBe(24);
   expect(await page.locator('.pc-topbar').getByRole('link',{name:'New task',exact:true}).count()).toBe(1);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
 }finally{await browser.close();}
},30_000); // One browser launch and two routes.
