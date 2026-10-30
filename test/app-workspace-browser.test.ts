import {expect,test} from 'bun:test';
import {chromium} from 'playwright-core';
const browserTest=test.skipIf(!process.env.PACER_TEST_BROWSER);
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
