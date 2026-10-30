import {expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
const executable=process.env.PACER_TEST_BROWSER??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':chromium.executablePath());
test.skipIf(!existsSync(executable))('mode switches optimistically, releases Automatic, and rolls back failures inline',async()=>{
 const build=await Bun.build({entrypoints:['test/fixtures/pacing-browser.tsx'],target:'browser'});
 if(!build.success)throw new AggregateError(build.logs);
 const script=await build.outputs[0]!.text();
 const calls:{op:string;params:unknown}[]=[];let fail=false,release:(()=>void)|undefined;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/fixture.js')return new Response(script,{headers:{'Content-Type':'text/javascript'}});
  if(!path.startsWith('/ops/'))return new Response('<div id="root"></div><script type="module" src="/fixture.js"></script>',{headers:{'Content-Type':'text/html'}});
  const op=path.slice(5);
  if(op==='config.get')return Response.json({keys:{},planners:[]});
  if(op==='account.list')return Response.json([]);
  if(op==='routing.status')return Response.json({calendarPace:true});
  calls.push({op,params:await request.json()});
  await new Promise<void>(resolve=>{release=resolve;});
  return fail?Response.json({code:'conflict',message:'Mode change rejected'},{status:409}):Response.json({});
 }});
 const browser=await chromium.launch({headless:true,executablePath:executable});
 try{
  const page=await browser.newPage();await page.goto(String(server.url));
  const button=(name:string)=>page.getByRole('button',{name,exact:true});
  await button('Automatic').waitFor();
  expect(await button('Automatic').getAttribute('aria-pressed')).toBe('true');
  for(const name of ['Hold strict','Automatic','Hold strict','Hold relaxed']) {
   release=undefined;await button(name).click();
   expect(await button(name).getAttribute('aria-pressed')).toBe('true');
   await page.locator('.pc-immediate-save__control[aria-busy=true]').waitFor();
   while(!release)await Bun.sleep(5);(release as ()=>void)();
   await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(b=>b.textContent==='Automatic'&&b.disabled));
  }
  fail=true;release=undefined;await button('Automatic').click();
  expect(await button('Automatic').getAttribute('aria-pressed')).toBe('true');
  while(!release)await Bun.sleep(5);(release as ()=>void)();
  await page.getByRole('alert').filter({hasText:"This setting changed elsewhere"}).waitFor();
  expect(await button('Hold relaxed').getAttribute('aria-pressed')).toBe('true');
  expect(calls.map(c=>c.op)).toEqual(['mode.hold','mode.release','mode.hold','mode.hold','mode.release']);
  expect(calls[3]?.params).toEqual({mode:'relaxed'});
 }finally{release?.();await browser.close();server.stop(true);}
},20000);

test.skipIf(!existsSync(executable))('planner selection confirms before saving, rolls back failures and cancels without a success notice',async()=>{
 const build=await Bun.build({entrypoints:['test/fixtures/pacing-browser.tsx'],target:'browser'});
 if(!build.success)throw new AggregateError(build.logs);
 const script=await build.outputs[0]!.text();
 let planner='codex',fail=false,release:(()=>void)|undefined;const writes:unknown[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const op=new URL(request.url).pathname.slice(5);
  if(!new URL(request.url).pathname.startsWith('/ops/'))return new Response('<div id="root"></div><script type="module">'+script+'</script>',{headers:{'Content-Type':'text/html'}});
  const params=await request.json();
  if(op==='config.get')return Response.json({keys:{planner:{value:planner}},planners:['codex','claude-code']});
  if(op==='account.list')return Response.json([]);
  if(op==='routing.status')return Response.json({calendarPace:true});
  if(op==='agent.preview')return Response.json({agent:params.agent,files:[],undo:''});
  if(op==='config.set'){
   writes.push(params);await new Promise<void>(resolve=>{release=resolve;});
   if(fail)return Response.json({code:'not_allowed',message:'config.set planner blocked'},{status:403});
   planner=params.value;return Response.json({});
  }
  return Response.json({});
 }});
 const browser=await chromium.launch({headless:true,executablePath:executable});
 try {
  const page=await browser.newPage();page.setDefaultTimeout(5000);await page.goto(String(server.url));
  const picker=page.getByRole('button',{name:'Planner',exact:true});
  const select=async(name:string)=>{await picker.click();await page.getByRole('option',{name,exact:true}).click();await page.getByRole('button',{name:'Change only',exact:true}).waitFor();};
  await select('Claude Code');expect(writes).toEqual([]);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  expect(await picker.textContent()).toContain('Codex');expect(await page.getByText('Saved',{exact:true}).count()).toBe(0);
  await select('Claude Code');await page.getByRole('button',{name:'Change only',exact:true}).click();
  while(!release)await Bun.sleep(5);
  expect(await page.getByRole('button',{name:'Close',exact:true}).count()).toBe(0);
  await page.keyboard.press('Escape');expect(await page.getByRole('dialog').count()).toBe(1);
  (release as ()=>void)();await page.locator('.pc-budget-planner').getByText('Saved',{exact:false}).waitFor();
  expect(await picker.textContent()).toContain('Claude Code');
  fail=true;release=undefined;await select('Codex');await page.getByRole('button',{name:'Change only',exact:true}).click();
  while(!release)await Bun.sleep(5);(release as ()=>void)();
  await page.locator('.pc-budget-planner').getByRole('alert').waitFor();
  expect(await picker.textContent()).toContain('Claude Code');expect(await page.getByRole('dialog').count()).toBe(0);
  expect(writes).toEqual([{key:'planner',value:'claude-code',integrations:'skip'},{key:'planner',value:'codex',integrations:'skip'}]);
 }finally{release?.();await browser.close();server.stop(true);}
},20000);
