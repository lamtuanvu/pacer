import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>;
let launchMode='interactive',terminal='auto',sets:unknown[]=[];
const aliases=Array.from({length:12},(_,index)=>({name:`devbox-${index+1}`,host:`192.0.2.${index+1}`}));
beforeAll(async()=>{
 if(!browserPath)return;
 const out=tmpDir();
 const built=Bun.spawn([process.execPath,'build','test/fixtures/machine-browser.tsx','--target','browser','--outdir',out],{stdout:'pipe',stderr:'pipe'});
 if(await built.exited)throw Error(await new Response(built.stderr).text());
 const script=await Bun.file(join(out,'machine-browser.js')).text();
 const styles=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css'].map(path=>Bun.file(path).text()))).join('\n');
 server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const path=new URL(req.url).pathname;
  if(!path.startsWith('/ops/'))return new Response(`<meta charset="utf-8"><div id="root"></div><style>${styles}</style><script type="module">${script}</script>`,{headers:{'Content-Type':'text/html'}});
  const op=path.slice(5),params=await req.json();
  if(op==='config.get')return Response.json({keys:{'execution.local_max_tasks':{value:2,source:'default'},'execution.launch_mode':{value:launchMode,source:'default'},'terminal.open':{value:terminal,source:'default'},'terminal.app':{value:'Terminal',source:'default'}},terminalChoices:[{value:'auto',label:'Automatic'},{value:'ghostty',label:'Ghostty'}],planners:[]});
  if(op==='host.suggest')return Response.json(aliases);
  if(op==='config.set'){sets.push(params);const previous=params.key==='terminal.open'?terminal:launchMode;if(params.key==='terminal.open')terminal=params.value;else launchMode=params.value;return Response.json({key:params.key,value:params.value,previous,diff:'',undo:'pacer config set '+params.key+' '+previous});}
  return Response.json({});
 }});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
},15000);
afterAll(async()=>{await browser?.close();server?.stop(true);});

browserTest('delegated task launch reads the current mode and switches it with the keyboard',async()=>{
 const page=await browser.newPage();
 try{
  await page.goto(String(server.url));
  const picker=page.getByRole('button',{name:/Delegated task launch/});
  await picker.waitFor();
  expect(await picker.textContent()).toContain('Interactive');
  expect(await page.getByText(/finish when the agent reports its result/).count()).toBe(1);
  await picker.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option',{name:'Headless'}).click();
  // The section rereads config.get after the change is saved.
  await page.getByRole('button',{name:/Delegated task launch/}).filter({hasText:'Headless'}).waitFor({timeout:5000});
  expect(sets).toEqual([{key:'execution.launch_mode',value:'headless'}]);
 }finally{await page.close();}
});

browserTest('SSH aliases filter in a scrollable list; session terminal select saves the existing preset',async()=>{
 sets=[];
 const page=await browser.newPage();
 try{
  await page.goto(String(server.url));
  const filter=page.getByRole('searchbox',{name:'Filter SSH aliases'});
  await filter.fill('devbox-12');
  expect(await page.locator('.u3-aliases button').count()).toBe(1);
  await page.getByRole('button',{name:'devbox-12 192.0.2.12',exact:true}).click();
  expect(await page.getByLabel('2 · Name it in pacer').inputValue()).toBe('devbox-12');
  expect(await page.getByRole('button',{name:'devbox-12 192.0.2.12',exact:true}).getAttribute('aria-pressed')).toBe('true');
  await filter.fill('no-match');
  await page.getByText('No SSH aliases match.',{exact:true}).waitFor();
  await filter.fill('');
  expect(await page.locator('.u3-aliases button').count()).toBe(12);
  expect(await page.locator('.u3-aliases').evaluate(node=>getComputedStyle(node).flexDirection)).toBe('column');
  const terminals=page.getByRole('button',{name:'Terminal for sessions',exact:true});
  await terminals.click();
  await page.getByRole('option',{name:'Ghostty',exact:true}).click();
  await terminals.filter({hasText:'Ghostty'}).waitFor();
  expect(sets).toEqual([{key:'terminal.open',value:'ghostty'}]);
  expect(await page.getByText('~/.pacer/worktrees',{exact:true}).count()).toBe(1);
 }finally{await page.close();}
});
