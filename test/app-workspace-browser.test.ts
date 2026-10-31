import {expect,test} from 'bun:test';
import {chromium} from 'playwright-core';
import {buildApp} from '../app/build';
const browserTest=test.skipIf(!process.env.PACER_TEST_BROWSER);
// Count terminal lifetimes without an unavailable fixture websocket triggering
// SessionClient's intentional reconnect backoff during simulated time.
const countedTerminal: import('bun').BunPlugin = {
 name:'count-terminal-streams',setup(builder){
  builder.onResolve({filter:/term\/LazyTerminal$/},()=>({path:'terminal',namespace:'counted-terminal'}));
  builder.onLoad({filter:/.*/,namespace:'counted-terminal'},()=>({loader:'tsx',contents:`
   import {h} from 'preact';import {useEffect} from 'preact/hooks';
   export function LazyTerminal(){useEffect(()=>{window.workspaceStreams=(window.workspaceStreams??0)+1;return()=>{window.workspaceStreamsClosed=(window.workspaceStreamsClosed??0)+1;};},[]);return h('div',{'aria-label':'Terminal stream fixture'});}
  `}));
 }
};
// Catches task navigation moving out of the actual scrollport (including behind
// the variable-height narrow header), rather than merely remaining in the DOM.
for (const width of [1440, 375]) for (const theme of ['light', 'dark'] as const) {
 browserTest(`workspace long Notes retain usable task tabs after wheel scrolling at ${width}px ${theme}`, async () => {
  const result = await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
  expect(result.success).toBe(true);
  const css = (await buildApp()).find(f => f.path === 'app.css')!.text;
  const browser = await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true,timeout:15000});
  try {
   const page = await browser.newPage({viewport:{width,height:900},colorScheme:theme});
   page.setDefaultTimeout(3000);page.setDefaultNavigationTimeout(10000);
   await page.route('http://pacer.test/**', r => r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
   await page.goto('http://pacer.test/?mode=longnotes&header=full#/workspace?task=workspace-task');
   await page.addStyleTag({content:css});
   await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
   await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
   const tabs = page.getByRole('tablist',{name:'Task details',exact:true});
   await tabs.waitFor();
   if (width === 375) {
    await page.mouse.move(200,600);await page.mouse.wheel(0,650);
    await page.waitForTimeout(250);
   }
   await tabs.getByRole('tab',{name:'Notes',exact:true}).click();
   const notes = page.getByRole('tabpanel',{name:'Notes',exact:true});
   await notes.getByText('Requirement 80:',{exact:false}).waitFor();
   await page.locator('.pc-workspace-task.pc-tab-swap').waitFor({state:'detached'});
   const metrics = () => tabs.evaluate(node => {
    const rect = node.getBoundingClientRect(), header = document.querySelector('.pc-topbar')!.getBoundingClientRect();
    const nav = document.querySelector('.pc-bottom-bar')?.getBoundingClientRect();
    const luminance = (color:string) => color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i]!,0);
    const background = luminance(getComputedStyle(node).backgroundColor);
    return {top:rect.top,bottom:rect.bottom,headerBottom:header.bottom,navTop:nav?.top??innerHeight,
     overflow:document.documentElement.scrollWidth>innerWidth,
     targets:[...node.querySelectorAll('[role="tab"]')].map(tab => {const r=tab.getBoundingClientRect(),foreground=luminance(getComputedStyle(tab).color);return {hit:tab.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),height:r.height,contrast:(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)};}),
     scroll:[...document.querySelectorAll('*')].filter(n=>n.scrollTop>0).map(n=>({name:n.className,top:n.scrollTop})),
     contentTop:document.querySelector('.pc-workspace-task__body')!.getBoundingClientRect().top};
   });
   const before = await metrics();
   const artifact = process.env.PACER_TABS_EVIDENCE;
   if(artifact)await page.screenshot({path:`${artifact}/${width}-${theme}-before-wheel.png`});
   // Pointer stays over Notes; no scrollTop assignment, forced click or layout override.
   await page.mouse.move(width===375?200:1300,500);
   await page.mouse.wheel(0,650);await page.waitForTimeout(250);
   const after = await metrics();
   if(artifact){await page.screenshot({path:`${artifact}/${width}-${theme}-after-wheel.png`});await Bun.write(`${artifact}/${width}-${theme}.json`,JSON.stringify({before,after},null,2));}
   expect(after.contentTop).toBeLessThan(before.contentTop-300);
   expect(after.top).toBeGreaterThanOrEqual(after.headerBottom-1);
   expect(after.bottom).toBeLessThanOrEqual(after.navTop);
   expect(after.overflow).toBe(false);
   for(const target of after.targets){expect(target.hit).toBe(true);expect(target.height).toBeGreaterThanOrEqual(width===375?44:28);expect(target.contrast).toBeGreaterThanOrEqual(4.5);}
   // Reach the end through more ordinary wheels; summary must clear bottom nav.
   await page.mouse.wheel(0,5000);await page.waitForTimeout(250);
   const end = await metrics();
   expect(end.top).toBeGreaterThanOrEqual(end.headerBottom-1);
   for(const target of end.targets)expect(target.hit).toBe(true);
   const summary = await notes.getByRole('heading',{name:'Summary',exact:true}).boundingBox();
   expect(summary!.y).toBeGreaterThan(end.bottom);
   expect(summary!.y+summary!.height).toBeLessThan(end.navTop);
   if(artifact){await page.screenshot({path:`${artifact}/${width}-${theme}-end.png`});await Bun.write(`${artifact}/${width}-${theme}-end.json`,JSON.stringify({end,summary},null,2));}
   // Hit tests above run before real clicks, so auto-scrolling cannot mask loss.
   for(const name of ['Overview','Changes','Notes']) {
    const tab=tabs.getByRole('tab',{name,exact:true});await tab.click();
    expect(await tab.getAttribute('aria-selected')).toBe('true');
    expect(await page.getByRole('tabpanel',{name,exact:true}).count()).toBe(1);
   }
   const overview=tabs.getByRole('tab',{name:'Overview',exact:true});
   await overview.focus();await page.keyboard.press('ArrowRight');
   const changes=tabs.getByRole('tab',{name:'Changes',exact:true});
   expect(await changes.evaluate(n=>n===document.activeElement)).toBe(true);
   expect(await changes.getAttribute('aria-selected')).toBe('true');
   expect(await changes.evaluate(n=>getComputedStyle(n).outlineStyle)).not.toBe('none');
   await page.keyboard.press('End');
   expect(await tabs.getByRole('tab',{name:'Notes',exact:true}).evaluate(n=>n===document.activeElement)).toBe(true);
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.keyboard.press('Home');
   expect(await overview.getAttribute('aria-selected')).toBe('true');
   expect(await page.locator('.pc-tab-leave').count()).toBe(0);
   if(width===375) {
    // Header wrapping changes while mounted; a token-sized fixed top is wrong.
    await tabs.getByRole('tab',{name:'Notes',exact:true}).click();
    await page.mouse.move(200,500);await page.mouse.wheel(0,650);await page.waitForTimeout(250);
    for(const resized of [560,375]) {
     await page.setViewportSize({width:resized,height:900});
     await page.waitForFunction(() => {
      const header=document.querySelector('.pc-topbar')!;
      return Math.abs(parseFloat(getComputedStyle(document.querySelector('.pc-app')!).getPropertyValue('--pc-frame-header-height'))-header.getBoundingClientRect().height)<1;
     });
     const reflow=await metrics();
     expect(reflow.top).toBeGreaterThanOrEqual(reflow.headerBottom-1);
     for(const target of reflow.targets)expect(target.hit).toBe(true);
     if(artifact)await Bun.write(`${artifact}/${width}-${theme}-reflow-${resized}.json`,JSON.stringify(reflow,null,2));
    }
   }
  } finally {await browser.close();}
 },20000);
}
browserTest('workspace resumes pending takeover and can control existing interactive sessions without a duplicate takeover',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[{name:'terminal-fixture',setup(builder){builder.onResolve({filter:/term\/LazyTerminal$/},()=>({path:'stub',namespace:'terminal-fixture'}));builder.onLoad({filter:/.*/,namespace:'terminal-fixture'},()=>({loader:'tsx',contents:`import {h} from 'preact';import {useEffect,useState} from 'preact/hooks';export function LazyTerminal(p){const [you,setYou]=useState(false);useEffect(()=>{if(p.takeRequested){setYou(true);p.onTakeSent?.();}},[p.takeRequested]);useEffect(()=>{if(p.control&&p.autoControl!==false&&!['following','childfile'].includes(new URLSearchParams(location.search).get('mode')))setYou(true);},[]);useEffect(()=>{p.onControlChange?.(you);p.onActions?.({release:()=>setYou(false),find(){},clear(){},reader(){}});},[you]);return h("div",{"aria-label":"Terminal fixture"},[you?"Driving":"Following",h("button",{onClick:()=>p.onOpenFile?.('src/a.ts')},"Open terminal file")]);}`}));}}]});
 expect(result.success).toBe(true);
 const css=(await buildApp()).find(f=>f.path==='app.css')!.text;
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{for(const mode of ['following','driving','starting','direct','childfile']){
  const page=await browser.newPage({viewport:{width:1440,height:900},colorScheme:'dark'});page.setDefaultTimeout(5000);await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto(`http://pacer.test/?mode=${mode}#/workspace?task=workspace-task${mode==='starting'?'&takeover=starting':mode==='direct'?'&takeover=1':''}`);await page.addScriptTag({type:"module",content:await result.outputs[0]!.text()});
  await page.addStyleTag({content:css});
  if(mode==='following'){
   const head=page.getByRole('button',{name:'Select task: Inspect workspace session',exact:true});await head.waitFor();
   expect(await head.locator('a,button').count()).toBe(0);
   expect(await page.getByRole('button',{name:'Take control',exact:true}).getAttribute('class')).toContain('pc-btn--secondary');
   expect(await page.locator('.pc-workspace-panel-details').textContent()).toContain('Watching · read-only');
   await head.click();expect(page.url()).toContain('#/workspace');
   await page.getByRole('button',{name:'Collapse sessions for Inspect workspace session',exact:true}).click();
   expect(await page.locator('.pc-workspace-session-icon').first().evaluate(n=>getComputedStyle(n).width)).toBe('26px');
   expect(await page.locator('.pc-workspace-session-toggle').evaluate(n=>getComputedStyle(n).height)).toBe('22px');
   await page.getByRole('button',{name:'Expand sessions for Inspect workspace session',exact:true}).click();
   expect(await page.locator('.pc-workspace-session-row').first().evaluate(n=>getComputedStyle(n).minHeight)).toBe('28px');
   await page.getByRole('button',{name:'Take control',exact:true}).click();}
  if(mode==='driving'){await page.getByRole('button',{name:'Take control',exact:true}).click();}
  if(mode==='childfile'){await page.locator('.pc-workspace-session-row').filter({hasText:'Codex'}).first().click();await page.getByRole('button',{name:'Take control',exact:true}).click();}
  await page.getByRole('button',{name:'Hand back',exact:true}).waitFor();
  expect(await page.evaluate(()=>(window as any).workspaceCalls.filter((op:string)=>op==='task.takeover'))).toEqual([]);
  if(mode==='following'){await page.mouse.move(0,899);await Bun.write('.work/fixtures/workspace-handback-metrics.json',JSON.stringify(await page.getByRole('button',{name:'Hand back',exact:true}).evaluate(n=>{const c=getComputedStyle(n);return {width:c.width,height:c.height,padding:c.padding,border:c.borderWidth,radius:c.borderRadius,color:c.color,background:c.backgroundColor,svg:getComputedStyle(n.querySelector('svg')!).width};}),null,2));}
  await page.getByRole('button',{name:'Hand back',exact:true}).click();await page.getByRole('button',{name:'Take control',exact:true}).waitFor();
  await page.getByRole('button',{name:'Take control',exact:true}).click();await page.getByRole('button',{name:'Hand back',exact:true}).waitFor();
  if(mode==='following'){
   await page.getByRole('button',{name:'Stop task',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'Stop task',exact:true}).click();
   expect(await page.evaluate(()=>(window as any).workspaceCalls)).toContain('task.stop');
   await page.getByRole('button',{name:'New panel',exact:true}).click();await page.getByRole('menuitem',{name:'Open a file…',exact:true}).click();
   await page.getByRole('textbox',{name:'Path in this task’s worktree'}).fill('src/a.ts');await page.getByRole('button',{name:'Open file',exact:true}).click();
   await page.getByRole('button',{name:'Open in editor',exact:true}).waitFor();await Bun.write('.work/fixtures/workspace-editor-metrics.json',JSON.stringify(await page.getByRole('button',{name:'Open in editor',exact:true}).evaluate(n=>{const c=getComputedStyle(n);return {width:c.width,height:c.height,padding:c.padding,border:c.borderWidth,radius:c.borderRadius,svg:getComputedStyle(n.querySelector('svg')!).width};}),null,2));expect(await page.locator('.pc-topbar').getByRole('button',{name:'Stop task',exact:true}).count()).toBe(0);
   await page.getByRole('button',{name:'Your shell · Fixture',exact:false}).click();
   expect(await page.locator('.pc-topbar .pc-frame-actions button').count()).toBe(0);
  }
  if(mode==='childfile'){
   await page.getByRole('button',{name:'Open terminal file',exact:true}).click();await page.getByRole('button',{name:'Open in editor',exact:true}).waitFor();
   expect(await page.evaluate(()=>(window as any).workspaceParams.some((c:any)=>c.op==='task.get'&&c.params.id==='workspace-child'))).toBe(true);
  }
  await page.close();
 }}finally{await browser.close();}
},30000);


browserTest('20-task workspace stays idle for 30 seconds and coalesces task event bursts',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 expect(result.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(3000);
  await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto('http://pacer.test/?mode=counts#/workspace');
  await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.getByRole('button',{name:'Select task: Workspace task 19',exact:true}).waitFor();
  await page.waitForTimeout(1000);
  const calls=()=>page.evaluate(()=>(window as any).workspaceCalls as string[]);
  expect((await calls()).filter(op=>op==='task.get')).toHaveLength(1);
  const initial=(await calls()).length;
  await page.clock.install();
  for(let second=0;second<30;second++){
   await page.evaluate(()=>(window as any).workspaceTick());
   await page.clock.runFor(1000);
  }
  expect((await calls()).length-initial).toBeLessThanOrEqual(5);
  expect((await calls()).filter(op=>op==='task.session')).toHaveLength(1);
  expect((await calls()).filter(op=>op==='terminal.list')).toHaveLength(1);
  expect(await page.evaluate(()=>(window as any).workspaceStreams)).toBe(1);
  expect(await page.evaluate(()=>(window as any).workspaceStreamsClosed??0)).toBe(0);
  const beforeEvents=(await calls()).filter(op=>op==='task.get').length;
  for(let tick=0;tick<10;tick++){
   await page.evaluate(()=>(window as any).workspaceTick(true));
   await page.clock.runFor(10);
  }
  await page.clock.runFor(1000);
  expect((await calls()).filter(op=>op==='task.get').length-beforeEvents).toBe(1);
  const before=(await calls()).filter(op=>op==='task.get').length;
  await page.getByRole('button',{name:'Select task: Workspace task 19',exact:true}).click();
  await page.clock.runFor(1000);
  expect((await calls()).filter(op=>op==='task.get').length-before).toBe(1);
 } finally {await browser.close();}
},30000);


browserTest('selecting a workspace task issues exactly one task.get and retained panels follow snapshot events',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 expect(result.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(3000);
  await page.route('http://pacer.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto('http://pacer.test/?mode=counts#/workspace');
  await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.getByRole('button',{name:'Stop task',exact:true}).waitFor();
  await page.getByRole('button',{name:/Attempt 1.*Codex/}).click();
  await page.getByText('No saved output is available for this earlier attempt.').waitFor();
  const count=()=>page.evaluate(()=>(window as any).workspaceCalls.filter((op:string)=>op==='task.get').length);
  const before=await count();
  await page.getByRole('button',{name:'Select task: Workspace task 19',exact:true}).click();
  await page.waitForTimeout(500);
  expect(await count()-before).toBe(1);
  expect(await page.getByText('No saved output is available for this earlier attempt.').count()).toBe(1);
  expect(await page.getByText('No saved output is available for this earlier attempt.').isVisible()).toBe(false);
  await page.getByRole('tab',{name:'Task workspace',exact:false}).first().click();
  await page.evaluate(()=>(window as any).workspaceFinish());
  await page.waitForTimeout(500);
  expect(await page.getByRole('button',{name:'Stop task',exact:true}).count()).toBe(0);
 } finally {await browser.close();}
},15000);

browserTest('queued workspace waits without a session request and follows the exact task when it starts',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
  await page.goto('http://pacer.test/?mode=queued#/workspace?task=workspace-task');await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.getByRole('region',{name:'Waiting to start',exact:true}).waitFor();
  expect(await page.getByText('Delegation is paused.',{exact:true}).count()).toBe(1);
  expect(await page.evaluate(()=>(window as any).workspaceCalls.filter((op:string)=>op==='task.session'))).toEqual([]);
  expect(await page.evaluate(()=>(window as any).workspaceStreams??0)).toBe(0);
  expect(await page.locator('[aria-label="Cost summary"]').textContent()).not.toContain('Agents used0');
  expect(await page.locator('[aria-label="Cost summary"]').textContent()).not.toContain('Changed');
  await page.getByRole('tab',{name:'Changes',exact:true}).click();
  await page.getByText('No task changes yet. Changes appear after this task starts.',{exact:true}).waitFor();
  await page.evaluate(()=>(window as any).workspaceStart());
  await page.getByLabel('Terminal stream fixture').waitFor({state:'attached'});
  expect(await page.evaluate(()=>(window as any).workspaceParams.filter((p:any)=>p.op==='task.session').map((p:any)=>p.params.id))).toEqual(['workspace-task']);
  expect(await page.getByRole('button',{name:'Take control',exact:true}).count()).toBe(1);
 }finally{await browser.close();}
},30000);

browserTest('workspace stopped state and questions provide the matching next action',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{for(const mode of ['stopped','question']){
  const page=await browser.newPage();await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
  await page.goto(`http://pacer.test/?mode=${mode}#/workspace?task=workspace-task`);await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  if(mode==='stopped'){
   await page.getByRole('heading',{name:'Task stopped',exact:true}).waitFor();
   expect(await page.getByText('Ready for your review',{exact:true}).count()).toBe(0);
   expect(await page.getByRole('button',{name:'Take control',exact:true}).count()).toBe(0);
   expect(await page.getByRole('button',{name:'Stop task',exact:true}).count()).toBe(0);
  }else{
   await page.getByRole('textbox',{name:'Your answer',exact:true}).fill('Use main');
   await page.getByRole('button',{name:'Send answer',exact:true}).click();
   await page.waitForFunction(()=>(window as any).workspaceParams.some((p:any)=>p.op==='task.answer'));
   expect(await page.evaluate(()=>(window as any).workspaceParams.find((p:any)=>p.op==='task.answer').params)).toMatchObject({id:'workspace-task',text:'Use main'});
  }
  await page.close();
 }}finally{await browser.close();}
},30000);

browserTest('child and retained panels own fresh detail through questions, completion and review',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(3000);await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
  await page.goto('http://pacer.test/?mode=childstates#/workspace?task=workspace-task&repo=api&scope=all');await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.locator('.pc-workspace-session-row').filter({hasText:'Codex'}).first().click();
  await page.getByRole('region',{name:'Question',exact:true}).getByText('Child question?',{exact:true}).waitFor();
  expect(await page.getByRole('button',{name:'Send answer',exact:true}).count()).toBe(1);
  await page.evaluate(()=>(window as any).workspaceChildFinish());
  await page.getByText('Fresh child summary',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Accept result',exact:true}).click();
  await page.getByRole('heading',{name:'Result accepted',exact:true}).waitFor();
  expect(await page.getByRole('button',{name:'Accept result',exact:true}).count()).toBe(0);
 }finally{await browser.close();}
},15000);

browserTest('a retained stopped panel follows a managed retry of the same task id',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(3000);await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
  await page.goto('http://pacer.test/?mode=following#/workspace?task=workspace-task');await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.getByRole('button',{name:'Stop task',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Stop task',exact:true}).click();
  await page.getByRole('heading',{name:'Task stopped',exact:true}).waitFor();
  await page.evaluate(()=>(window as any).workspaceStart());
  await page.getByRole('button',{name:'Take control',exact:true}).waitFor();
  expect(await page.getByRole('heading',{name:'Task stopped',exact:true}).count()).toBe(0);
 }finally{await browser.close();}
},15000);

browserTest('workspace retry preserves repository scope and opens the returned workspace',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(3000);await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
  await page.goto('http://pacer.test/?mode=failedretry#/workspace?task=workspace-task&repo=api&scope=all');await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:/^Retry on /}).click();
  await page.waitForURL(/#\/workspace\?task=retried-task&repo=api&scope=all/);
 }finally{await browser.close();}
},15000);

browserTest('unmanaged answers follow the returned retry while managed answers retain the workspace',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{for(const mode of ['question','managedquestion']){
  const page=await browser.newPage();page.setDefaultTimeout(3000);await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
  await page.goto(`http://pacer.test/?mode=${mode}#/workspace?task=workspace-task&repo=api&scope=all`);await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.getByRole('textbox',{name:'Your answer',exact:true}).fill('Use main');await page.getByRole('button',{name:'Send answer',exact:true}).click();
  if(mode==='question')await page.waitForURL(/#\/workspace\?task=answer-retry&repo=api&scope=all/);
  else{
   await page.getByRole('region',{name:'Waiting to start',exact:true}).waitFor();
   expect(page.url()).toContain('#/workspace?task=workspace-task&repo=api&scope=all');
   expect(await page.evaluate(()=>(window as any).workspaceParams.find((p:any)=>p.op==='dispatch.answer').params)).toMatchObject({id:'workspace-task',text:'Use main',requestId:expect.any(String)});
  }
  await page.close();
 }}finally{await browser.close();}
},15000);

browserTest('workspace without an id opens its initial selection once and respects closing the panel',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(3000);await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
  await page.goto('http://pacer.test/?mode=noid#/workspace');await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.getByLabel('Terminal stream fixture').waitFor({state:'attached'});
  await page.getByRole('button',{name:'Close Task workspace',exact:true}).click();
  await page.evaluate(()=>(window as any).workspaceTick(true));
  await page.waitForTimeout(400);
  expect(await page.getByRole('tab',{name:'Task workspace',exact:false}).count()).toBe(0);
 }finally{await browser.close();}
},15000);
browserTest('workspace menu remains pointer reachable after panel resizing and viewport changes',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const css=(await buildApp()).find(f=>f.path==='app.css')!.text;
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(3000);
  await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto('http://pacer.test/#/workspace');
  await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});await page.addStyleTag({content:css});
  await page.getByRole('button',{name:'New panel',exact:true}).waitFor();
  const geometry=await page.evaluate(()=>{
   const box=(selector:string)=>document.querySelector(selector)!.getBoundingClientRect();
   return {main:box('.pc-main').toJSON(),workspace:box('.pc-workspace').toJSON(),strip:box('.pc-workspace-panels').height,status:box('.pc-statusbar').top};
  });
  expect(geometry.workspace.x).toBe(geometry.main.x);
  expect(geometry.workspace.y).toBe(geometry.main.y);
  expect(geometry.workspace.bottom).toBe(geometry.status);
  expect(geometry.strip).toBe(31);
  // Compare portal exit with native traversal from its trigger in the full frame.
  const trigger=page.getByRole('button',{name:'New panel',exact:true});
  for(const key of ['Tab','Shift+Tab']) {
   await trigger.focus();await page.keyboard.press(key);
   await page.evaluate(()=>{(window as any).workspaceTabTarget=document.activeElement;});
   for(const edge of ['Home','End']) {
    await trigger.focus();await page.keyboard.press('Enter');await page.keyboard.press(edge);
    await page.keyboard.press(key);
    expect(await page.getByRole('menu',{name:'New panel',exact:true}).count()).toBe(0);
    expect(await page.evaluate(()=>document.activeElement===(window as any).workspaceTabTarget)).toBe(true);
   }
  }
  await page.getByRole('button',{name:'New panel',exact:true}).click();
  await page.keyboard.press('End');
  expect(await page.getByRole('menuitem',{name:'Open a file…',exact:true}).evaluate(n=>n===document.activeElement)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.getByRole('button',{name:'New panel',exact:true}).evaluate(n=>n===document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  for(const width of [1440,1100,767,640,561,390,375]) {
   await page.setViewportSize({width,height:900});
   if(width===1100){await page.getByRole('separator',{name:'Resize Workspace',exact:true}).focus();await page.keyboard.press('End');}
   if(width<=390) {
    for(const control of [page.getByRole('button',{name:'Search',exact:true}),page.getByRole('button',{name:'Stop task',exact:true}),page.getByRole('button',{name:'Take control',exact:true}),page.getByRole('link',{name:'New task',exact:true})]) {
     const bounds=await control.boundingBox();
     expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
    }
   }
   const item=page.getByRole('menuitem',{name:'Open a file…',exact:true});
   await page.waitForFunction(width => document.querySelector('.pc-app')?.classList.contains('pc-app--narrow') === (width <= 560), width);
   const visibility = await page.getByRole('menu', {name:'New panel',exact:true}).evaluate(menu => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(item => {
    const r=item.getBoundingClientRect(), range=document.createRange();range.selectNodeContents(item);const text=range.getBoundingClientRect();
    const hit=(x:number,y:number)=>item.contains(document.elementFromPoint(x,y));
    return {label:item.textContent,left:hit(r.left+1,r.top+r.height/2),right:hit(r.right-1,r.top+r.height/2),textLeft:hit(text.left+1,text.top+text.height/2),textRight:hit(text.right-1,text.top+text.height/2),fits:text.left>=r.left&&text.right<=r.right};
   }));
   for(const target of visibility) expect(target).toMatchObject({left:true,right:true,textLeft:true,textRight:true,fits:true});
   await item.click({trial:true});
   const box=await page.getByRole('menu',{name:'New panel',exact:true}).boundingBox();
   expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width);
  }
  await page.getByRole('menuitem',{name:'New agent session…',exact:true}).click();
  await page.getByRole('dialog',{name:'New agent session',exact:true}).waitFor();
 } finally {await browser.close();}
},15000);

browserTest('ended workspace metadata is truthful and failed session reads recover without a stuck skeleton',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {for(const mode of ['ended','loaderror','headless']) {
  const page=await browser.newPage();page.setDefaultTimeout(3000);
  await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto(`http://pacer.test/?mode=${mode}#/workspace`);await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  if(mode==='ended') {
   await page.getByRole('region',{name:'Task result',exact:true}).waitFor();
   const text=await page.locator('.pc-topbar__context').innerText();
   expect(text).toContain('Ended · read-only');expect(text).not.toContain('Following');expect(text).not.toMatch(/·\s*·/);
  } else if(mode==='headless') {
   await page.getByRole('button',{name:'Take control',exact:true}).waitFor();
   expect(await page.locator('.pc-topbar__context').innerText()).toContain('Output · read-only');
  } else {
   await page.getByRole('alert').filter({hasText:'Session unavailable'}).waitFor();
   expect(await page.getByLabel('Loading session').count()).toBe(0);
   await page.getByRole('button',{name:'Retry session',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'attempt 2'}).waitFor();
   expect(await page.getByLabel('Loading session').count()).toBe(0);
   await page.evaluate(()=>(window as any).workspaceRecover());
   await page.getByRole('button',{name:'Retry session',exact:true}).click();
   await page.getByLabel('Terminal stream fixture').waitFor({state:'attached'});
   expect(await page.getByRole('alert').count()).toBe(0);
  }
  await page.close();
 }} finally {await browser.close();}
},15000);


browserTest('workspace long identity and status stay inside their context in both themes',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 expect(result.success).toBe(true);
 const css=(await buildApp()).find(f=>f.path==='app.css')!.text;
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {for(const mode of ['accepted','longidentity']) {
  const page=await browser.newPage();page.setDefaultTimeout(3000);
  await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto(`http://pacer.test/?mode=${mode}#/workspace`);
  await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});await page.addStyleTag({content:css});
  await page.locator('.pc-workspace-panel-details b').waitFor();
  for(const theme of ['dark','light'])for(const width of [1440,375,390,340]) {
   await page.setViewportSize({width,height:900});
   await page.locator(width<768?'.pc-app--narrow':'.pc-app:not(.pc-app--narrow)').waitFor();
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   const fit=await page.locator('.pc-workspace-panel-details').evaluate(node=>{
    const box=(n:Element)=>n.getBoundingClientRect().toJSON();
    const title=node.querySelector('b')!,pill=node.querySelector('.pc-pill')!,meta=node.querySelector(':scope>div>span')!;
    const c=getComputedStyle(pill);
    const luminance=(color:string)=>color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i]!,0);
    const a=luminance(c.color),b=luminance(c.backgroundColor);
    return {context:box(node.parentElement!),identity:box(node),children:[...node.children].map(box),title:box(title),pill:box(pill),fullTitle:title.getAttribute('title'),text:title.textContent,metadata:meta.getAttribute('title'),metaText:meta.textContent,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),status:pill.textContent};
   });
   expect(fit.contrast).toBeGreaterThanOrEqual(4.5);
   expect(fit.identity.left).toBeGreaterThanOrEqual(fit.context.left);
   expect(fit.identity.right).toBeLessThanOrEqual(fit.context.right+.1);
   for(const child of fit.children){expect(child.left).toBeGreaterThanOrEqual(fit.identity.left);expect(child.right).toBeLessThanOrEqual(fit.identity.right+.1);}
   expect(fit.title.width).toBeGreaterThan(0);expect(fit.title.right).toBeLessThan(fit.pill.left);
   expect(fit.fullTitle).toBe(fit.text);expect(fit.metadata).toBe(fit.metaText);
   expect(fit.contrast).toBeGreaterThanOrEqual(4.5);
   if(mode==='accepted')expect(fit.status).toBe('Accepted');
   if(width<768)await page.getByRole('button',{name:'Search',exact:true}).click({trial:true});
   await page.getByRole('button',{name:'New panel',exact:true}).click();
   await page.keyboard.press('End');await page.keyboard.press('Escape');
   expect(await page.getByRole('button',{name:'New panel',exact:true}).evaluate(n=>n===document.activeElement)).toBe(true);
  }
  await page.close();
 }}finally{await browser.close();}
},30000);

browserTest('workspace inline panels keep New panel reachable across the frame boundary', async () => {
 const result = await Bun.build({entrypoints: ['test/fixtures/workspace-browser.tsx'], target: 'browser', format: 'esm', tsconfig: 'app/tsconfig.json', plugins: [countedTerminal]});
 expect(result.success).toBe(true);
 const css = (await buildApp()).find(f => f.path === 'app.css')!.text;
 const browser = await chromium.launch({executablePath: process.env.PACER_TEST_BROWSER!, headless: true});
 try {
  for (const theme of ['light', 'dark'] as const) {
   const page = await browser.newPage({viewport: {width: 1440, height: 900}, colorScheme: theme});
   page.setDefaultTimeout(3000);
   await page.route('http://pacer.test/**', r => r.fulfill({contentType: 'text/html', body: '<!doctype html><div id="app"></div>'}));
   await page.goto('http://pacer.test/#/workspace');
   await page.addStyleTag({content: css});
   await page.addScriptTag({type: 'module', content: await result.outputs[0]!.text()});
   // Descend and ascend: stale frame-slot portals must not duplicate the inline panels.
   for (const width of [1440, 375, 560, 561, 640, 767, 768, 767, 561, 560, 768]) {
    await page.setViewportSize({width, height: 900});
    const trigger = page.getByRole('button', {name: 'New panel', exact: true});
    await trigger.waitFor();
    await page.waitForFunction(({width}) =>
     !!document.querySelector('.pc-app--narrow') === (width <= 560) &&
     document.querySelectorAll('.pc-side-panel').length === (width >= 768 ? 2 : 0) &&
     document.querySelectorAll('.pc-workspace-task').length === 1, {width});
    await trigger.evaluate(button => button.scrollIntoView({block: 'nearest'}));
    const geometry = await page.evaluate(() => {
     const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON();
     const b = document.querySelector('[aria-label="New panel"]')!;
     const r = b.getBoundingClientRect();
     const w = document.querySelector('.pc-workspace')!;
     return {list: rect('.pc-workspace-list'), center: rect('.pc-workspace-center'), task: rect('.pc-workspace-task'), button: r.toJSON(), direction: getComputedStyle(w).flexDirection,
      hit: b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      overflow: document.documentElement.scrollWidth > innerWidth};
    });
    expect(geometry.direction).toBe(width < 768 ? 'column' : 'row');
    expect(geometry.overflow).toBe(false);
    expect(geometry.button.width).toBeGreaterThan(0);
    expect({width,theme,geometry}).toMatchObject({geometry:{hit:true}});
    if (width < 768) {
     expect(geometry.list.bottom).toBeLessThanOrEqual(geometry.center.top + 1);
     expect(geometry.center.bottom).toBeLessThanOrEqual(geometry.task.top + 1);
     expect(geometry.center.width).toBeGreaterThanOrEqual(geometry.list.width - 1);
    }
    await trigger.click();
    const file = page.getByRole('menuitem', {name: 'Open a file…', exact: true});
    await file.click({trial: true});
    await page.keyboard.press('End');
    expect(await file.evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await trigger.evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Home');
    expect(await page.getByRole('menuitem', {name: 'New shell in this worktree', exact: true}).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    await page.getByRole('link', {name: 'Task history', exact: true}).click({trial: true});
   }
   await page.close();
  }
 } finally { await browser.close(); }
}, 30000);


browserTest('workspace header contains full identity, status and actions at intermediate widths', async () => {
 const result = await Bun.build({entrypoints: ['test/fixtures/workspace-browser.tsx'], target: 'browser', format: 'esm', tsconfig: 'app/tsconfig.json', plugins: [countedTerminal]});
 expect(result.success).toBe(true);
 const css = (await buildApp()).find(f => f.path === 'app.css')!.text;
 const browser = await chromium.launch({executablePath: process.env.PACER_TEST_BROWSER!, headless: true});
 try {
  for (const mode of ['longidentity', 'accepted', 'headless']) {
   const page = await browser.newPage();
   page.setDefaultTimeout(3000);
   await page.route('http://pacer.test/**', r => r.fulfill({contentType: 'text/html', body: '<!doctype html><div id="app"></div>'}));
   await page.goto(`http://pacer.test/?mode=${mode}&header=full#/workspace`);
   await page.addStyleTag({content: css});
   await page.addScriptTag({type: 'module', content: await result.outputs[0]!.text()});
   await page.locator('.pc-workspace-panel-details b').waitFor();
   for (const theme of ['light', 'dark']) for (const width of [1440, 375, 560, 561, 640, 767, 768, 800, 801, 1100, 1101, 768, 560, 561]) {
    await page.setViewportSize({width, height: 900});
    await page.waitForFunction(w => !!document.querySelector('.pc-app--narrow') === (w <= 560), width);
    await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
    const geometry = await page.locator('.pc-topbar').evaluate(header => {
     const identity = header.querySelector('.pc-workspace-panel-details')!;
     const title = identity.querySelector('b')!.getBoundingClientRect();
     const status = identity.querySelector('.pc-pill')!;
     const sr = status.getBoundingClientRect();
     const hr = header.getBoundingClientRect();
     const controls = [...header.querySelectorAll('button:not(:disabled),a')].filter(n => n.getBoundingClientRect().width > 0);
     return {overflow: document.documentElement.scrollWidth > innerWidth, titleWidth: title.width,
      statusWidth: sr.width, statusFits: sr.left >= hr.left && sr.right <= hr.right && sr.top >= hr.top && sr.bottom <= hr.bottom && status.scrollWidth <= status.clientWidth,
      controls: controls.map(n => {const r = n.getBoundingClientRect(); return {name: n.getAttribute('aria-label') ?? n.textContent, contained: r.left >= 0 && r.right <= innerWidth && r.top >= hr.top && r.bottom <= hr.bottom, hit: n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))};})};
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.titleWidth).toBeGreaterThan(40);
    expect(geometry.statusWidth).toBeGreaterThan(20);
    expect(geometry.statusFits).toBe(true);
    for (const control of geometry.controls) {
     expect({...control, contained: true, hit: true}).toEqual(control);
    }
    await page.locator('[data-command-trigger]').click({trial: true});
    await page.getByRole('link', {name: 'New task', exact: true}).click({trial: true});
    if (mode === 'headless') await page.getByRole('button', {name: 'Take control', exact: true}).click({trial: true});
   }
   await page.close();
  }
 } finally { await browser.close(); }
}, 30000);

browserTest('new interactive agents stay under one task and use independent sessions and revisions',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});
 expect(result.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(4000);
  await page.route('http://127.0.0.1:9876/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto('http://127.0.0.1:9876/#/workspace?task=workspace-task');await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.addStyleTag({content:(await buildApp()).find(f=>f.path==='app.css')!.text});
  for(const request of ['Inspect authentication','Inspect persistence']){
   await page.getByRole('button',{name:'New panel',exact:true}).click();await page.getByRole('menuitem',{name:'New agent session…',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'New agent session',exact:true});await dialog.waitFor();
   await dialog.getByRole('button',{name:'Agent',exact:true}).click();await page.getByRole('option').filter({hasText:'codex'}).click();
   await dialog.getByRole('textbox',{name:'Request',exact:true}).fill(request);
   await dialog.getByRole('button',{name:'Start agent session',exact:true}).click();await dialog.waitFor({state:'hidden'});
  }
  await page.getByRole('tab',{name:'Codex · Session 1',exact:false}).waitFor();await page.getByRole('tab',{name:'Codex · Session 2',exact:false}).waitFor();
  expect(await page.getByRole('button',{name:'Select task: Inspect workspace session',exact:true}).count()).toBe(1);
  expect(page.url()).toContain('task=workspace-task');
  await page.getByRole('button',{name:'End session',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'End session',exact:true}).click();
  await page.getByRole('button',{name:'Resume conversation',exact:true}).waitFor();
  await page.getByRole('tab',{name:'Codex · Session 1',exact:false}).click();await page.getByRole('button',{name:'End session',exact:true}).waitFor();
  const calls=await page.evaluate(()=>(window as any).workspaceParams.filter((c:any)=>c.op==='session.agent.create'||c.op==='session.agent.end'));
  expect(calls.filter((c:any)=>c.op==='session.agent.create')).toHaveLength(2);
  expect(calls.every((c:any)=>c.params.task_id==='workspace-task')).toBe(true);
  expect(calls.find((c:any)=>c.op==='session.agent.end').params.id).toBe('00000000-0000-4000-8000-000000000002');
  expect(await page.evaluate(()=>(window as any).workspaceCalls.includes('session.create'))).toBe(false);
 }finally{await browser.close();}
},20000);

browserTest('real 30-second idle workspace stays within five reads with zero and multiple hidden and visible agents',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[countedTerminal]});expect(result.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{await Promise.all([0,3].map(async count=>{
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(4000);
  await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto('http://pacer.test/#/workspace?task=workspace-task');await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.addStyleTag({content:(await buildApp()).find(f=>f.path==='app.css')!.text});
  await page.getByRole('button',{name:'New panel',exact:true}).waitFor();
  for(let n=0;n<count;n++){
   await page.evaluate(()=>(window as any).workspaceAgentEvent('create'));
   const row=page.locator('.pc-workspace-session-row').filter({hasText:`Session ${n+1}`});await row.waitFor();await row.click();
  }
  if(count)expect(await page.getByRole('tab',{name:/Codex · Session/}).count()).toBe(count);
  await page.waitForTimeout(500);
  const start=await page.evaluate(()=>(window as any).workspaceCalls.length),at=Date.now();
  await page.waitForTimeout(30000);
  const reads=await page.evaluate(n=>(window as any).workspaceCalls.slice(n),start);
  await Bun.write(`.work/reviews/pr509-session-corrections/idle-${count}.json`,JSON.stringify({sessions:count,visible:count?1:0,hidden:Math.max(0,count-1),elapsedMs:Date.now()-at,reads},null,2));
  expect(reads.length).toBeLessThanOrEqual(5);
  // A second client's creation, then a service-observed exit, updates the retained panels.
  await page.evaluate(()=>(window as any).workspaceAgentEvent('create'));
  const row=page.locator('.pc-workspace-session-row').filter({hasText:`Session ${count+1}`});await row.waitFor();await row.click();
  await page.getByRole('button',{name:'End session',exact:true}).waitFor();
  await page.evaluate(()=>(window as any).workspaceAgentEvent('exit'));
  await page.getByRole('button',{name:'Start fresh conversation',exact:true}).waitFor();
  await page.screenshot({path:`.work/reviews/pr509-session-corrections/workspace-${count}.png`,fullPage:true});
  await page.close();
 }));}finally{await browser.close();}
},45000);
