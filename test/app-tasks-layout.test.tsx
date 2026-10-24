import {expect, test} from 'bun:test';
import {chromium} from 'playwright-core';
import {renderToString} from 'preact-render-to-string';
import {SessionsList} from '../app/src/screens/session/SessionsList';
import {NarrowContext} from '../app/src/ds/Density';
import {sessionRow} from '../app/src/screens/session/controller';
import type {StoreState} from '../app/src/data/store';
import type {BrowserApi} from '../app/src/data/api';
import type {ClientTask} from '../src/view-model/snapshot';

const task = {id:'ended',title:'Implement ticket SFOS-488…',fullTitle:'Implement ticket SFOS-488 (ZDD-A3) in the infrastructure repository',goal:'Implement ticket',state:'done',executor:'codex',backend:null,worktree:null,updatedAt:Math.floor(Date.now()/1000),repo:{label:'terastor/storfabricos-infra'}} as ClientTask;

test('Tasks retains the complete display title in text, tooltip and destination name',()=>{
 const html=renderToString(<SessionsList recent={{data:[sessionRow(task)]}}/>);
 expect(html).toContain(`>${task.fullTitle}</strong>`);
 expect(html).toContain(`title="${task.fullTitle}"`);
 expect(html).toContain(`aria-label="View result ${task.fullTitle}"`);
 expect(sessionRow({...task,fullTitle:undefined}).title).toBe(task.title);
});

const browserPath=process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('Tasks bounds wide rows and keeps titles, metadata and actions inside narrow viewports',async()=>{
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/session/session.css'].map(f=>Bun.file(f).text()))).join('\n');
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try{
  const page=await browser.newPage();
  for(const width of [1990,1440,375])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:1000});
   await page.setContent(`<html data-theme="${theme}"><style>${css}</style>${renderToString(<NarrowContext.Provider value={width<560}><SessionsList running={{data:[sessionRow({...task,state:'running'})]}} recent={{data:[sessionRow(task)]}}/></NarrowContext.Provider>)}</html>`);
   if(process.env.PACER_LAYOUT_EVIDENCE)await page.screenshot({path:`${process.env.PACER_LAYOUT_EVIDENCE}/tasks-${width}-${theme}.png`});
   const geometry=await page.locator('.pc-sessions-list').evaluate(n=>({width:n.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}));
   expect(geometry.width).toBeLessThanOrEqual(1300);
   expect(geometry.overflow).toBe(false);
   const boxes=await page.locator('.pc-list-row__content,.pc-list-row__meta,.pc-list-row__actions').evaluateAll(nodes=>nodes.map(n=>({left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width})));
   for(const box of boxes){expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(width);expect(box.width).toBeGreaterThan(0);}
  }
 }finally{await browser.close();}
});

test.skipIf(!browserPath)('Start work truncates long recent titles with an ellipsis and keeps desktop and phone shells contained',async()=>{
 const {StartSession}=await import('../app/src/screens/StartSession');
 const {TaskContext}=await import('../app/src/screens/task-shared');
 const {initialState}=await import('../app/src/data/store');
 const {Layout}=await import('../app/src/shell/Layout');
 const fixture=(await import('./fixtures/ui/snapshot.json')).default;
 const state={...initialState(),connected:true,features:{readModel:true,ops:new Set<string>(["session.create"])},snapshot:{...fixture,tasks:[{...fixture.tasks[0]!,fullTitle:'Implement ticket SFOS-488: '+ 'Complete the deployment-target implementation and verify all affected infrastructure. '.repeat(12)}]}};
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css'].map(f=>Bun.file(f).text()))).join('\n');
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try{
  const page=await browser.newPage();
  for(const width of [1990,1440,375])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:1000});
   const html=renderToString(<TaskContext.Provider value={{state:state as unknown as StoreState,api:{} as BrowserApi}}><Layout route={{name:'start',query:{repo:null,scope:width<560?'repo:sample':null}}} state={state as unknown as StoreState} title="Start work"><StartSession/></Layout></TaskContext.Provider>);
   await page.setContent(`<html data-theme="${theme}" data-pacer-desktop data-pacer-native-titlebar><div id="app"><style>${css}</style>${html}</div></html>`);
   if(process.env.PACER_LAYOUT_EVIDENCE)await page.screenshot({path:`${process.env.PACER_LAYOUT_EVIDENCE}/start-${width}-${theme}.png`});
   expect(await page.locator('.pc-start-recent .pc-ellipsis').count()).toBe(1);
   const title=page.locator('.pc-start-recent .pc-ellipsis');
   expect(await title.getAttribute('title')).toBe(state.snapshot.tasks[0]!.fullTitle);
   expect(await title.evaluate(n=>({clipped:n.scrollWidth>n.clientWidth,overflow:getComputedStyle(n).textOverflow}))).toEqual({clipped:true,overflow:'ellipsis'});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const rail=await page.locator(width<560?'.pc-bottom-bar':'.pc-rail').evaluate(n=>n.getBoundingClientRect().left);
   expect(rail).toBeGreaterThanOrEqual(0);
  }
 }finally{await browser.close();}
});
