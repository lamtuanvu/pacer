import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser,type Page} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>;
let maxTasks=2,sets:unknown[]=[];
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
  if(op==='config.get')return Response.json({keys:{'execution.local_max_tasks':{value:maxTasks,source:'user'},'execution.launch_mode':{value:'interactive',source:'default'},'terminal.open':{value:'',source:'default'},'terminal.app':{value:'Terminal',source:'default'}},terminalChoices:[{value:'auto',label:'Automatic'}],planners:[]});
  if(op==='config.set'){sets.push(params);const previous=maxTasks;maxTasks=params.value;return Response.json({key:params.key,value:maxTasks,previous,diff:'',undo:`pacer config set execution.local_max_tasks ${previous}`});}
  return Response.json({});
 }});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
},15000);
afterAll(async()=>{await browser?.close();server?.stop(true);});

async function open():Promise<Page>{
 maxTasks=2;sets=[];
 const page=await browser.newPage();
 await page.goto(String(server.url));
 await page.getByLabel('Parallel tasks on this machine').waitFor();
 return page;
}
const field=(page:Page)=>page.getByLabel('Parallel tasks on this machine');
const save=(page:Page)=>page.getByRole('button',{name:'Save changes'});
const error=(page:Page)=>page.getByText('Enter a whole number from 1 to 16.');

browserTest('the parallel-task limit keeps typed text and saves only on Save',async()=>{
 const page=await open();
 try{
  expect(await field(page).inputValue()).toBe('2');
  expect(await save(page).isDisabled()).toBe(true);
  await field(page).fill('');
  expect(await field(page).inputValue()).toBe('');
  await field(page).pressSequentially('6');
  expect(await field(page).inputValue()).toBe('6');
  expect(await field(page).isEnabled()).toBe(true);
  expect(await page.getByText('Unsaved changes').count()).toBe(1);
  expect(sets).toEqual([]);
  await save(page).click();
  await page.getByText('All changes saved').waitFor({timeout:5000});
  expect(sets).toEqual([{key:'execution.local_max_tasks',value:6}]);
  expect(await field(page).inputValue()).toBe('6');
 }finally{await page.close();}
});

browserTest('invalid parallel-task limits show an error and cannot be saved',async()=>{
 const page=await open();
 try{
  for(const text of ['0','17','']){
   await field(page).fill(text);
   expect(await field(page).inputValue()).toBe(text);
   await error(page).waitFor();
   expect(await save(page).isDisabled()).toBe(true);
  }
  await field(page).fill('16');
  expect(await error(page).count()).toBe(0);
  expect(await save(page).isEnabled()).toBe(true);
  expect(sets).toEqual([]);
 }finally{await page.close();}
});

browserTest('Discard restores the saved parallel-task limit',async()=>{
 const page=await open();
 try{
  await field(page).fill('9');
  await page.getByRole('button',{name:'Discard'}).click();
  expect(await field(page).inputValue()).toBe('2');
  expect(await page.getByText('All changes saved').count()).toBe(1);
  expect(sets).toEqual([]);
 }finally{await page.close();}
});
