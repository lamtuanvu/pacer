import {expect,test} from 'bun:test';
import {chromium} from 'playwright-core';
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
 const result=await Bun.build({entrypoints:['test/fixtures/workspace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json',plugins:[{name:'terminal-fixture',setup(builder){builder.onResolve({filter:/term\/LazyTerminal$/},()=>({path:'stub',namespace:'terminal-fixture'}));builder.onLoad({filter:/.*/,namespace:'terminal-fixture'},()=>({loader:'tsx',contents:`import {h} from 'preact';import {useEffect} from 'preact/hooks';export function LazyTerminal(p){useEffect(()=>{p.onControlChange?.(!!p.control);p.onActions?.({release:()=>p.onControlChange?.(false),find(){},clear(){},reader(){}});if(p.takeRequested)p.onTakeSent?.();},[p.control,p.takeRequested]);return h("div",{"aria-label":"Terminal fixture"},p.control?"Driving":"Following");}`}));}}]});
 expect(result.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{for(const mode of ['following','driving','starting','direct']){
  const page=await browser.newPage();page.setDefaultTimeout(5000);await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto(`http://pacer.test/?mode=${mode}#/workspace?task=workspace-task${mode==='starting'?'&takeover=starting':mode==='direct'?'&takeover=1':''}`);await page.addScriptTag({type:"module",content:await result.outputs[0]!.text()});
  if(mode==='following'){await page.getByRole('button',{name:'Take over',exact:true}).click();}
  await page.getByRole('button',{name:'Hand back',exact:true}).waitFor();
  expect(await page.evaluate(()=>(window as any).workspaceCalls.filter((op:string)=>op==='task.takeover'))).toEqual([]);
  await page.getByRole('button',{name:'Hand back',exact:true}).click();await page.getByRole('button',{name:'Take over',exact:true}).waitFor();
  await page.getByRole('button',{name:'Take over',exact:true}).click();await page.getByRole('button',{name:'Hand back',exact:true}).waitFor();await page.close();
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
  await page.getByRole('button',{name:'End session',exact:true}).waitFor();
  await page.getByRole('button',{name:/Attempt 1.*Codex/}).click();
  await page.getByText('No saved output is available for this earlier attempt.').waitFor();
  const count=()=>page.evaluate(()=>(window as any).workspaceCalls.filter((op:string)=>op==='task.get').length);
  const before=await count();
  await page.getByRole('button',{name:'Select task: Workspace task 19',exact:true}).click();
  await page.waitForTimeout(500);
  expect(await count()-before).toBe(1);
  expect(await page.getByText('No saved output is available for this earlier attempt.').count()).toBe(1);
  await page.getByRole('tab',{name:'Codex',exact:false}).first().click();
  await page.evaluate(()=>(window as any).workspaceFinish());
  await page.waitForTimeout(500);
  expect(await page.getByRole('button',{name:'End session',exact:true}).count()).toBe(0);
 } finally {await browser.close();}
},15000);
