import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>;
let launchMode='interactive',sets:unknown[]=[];
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
  if(op==='config.get')return Response.json({keys:{'execution.local_max_tasks':{value:2,source:'default'},'execution.launch_mode':{value:launchMode,source:'default'},'terminal.open':{value:'',source:'default'},'terminal.app':{value:'Terminal',source:'default'}},terminalChoices:[{value:'auto',label:'Automatic'}],planners:[]});
  if(op==='config.set'){sets.push(params);const previous=launchMode;launchMode=params.value;return Response.json({key:params.key,value:launchMode,previous,diff:'',undo:`pacer config set execution.launch_mode ${previous}`});}
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
