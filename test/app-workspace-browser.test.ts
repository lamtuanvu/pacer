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
