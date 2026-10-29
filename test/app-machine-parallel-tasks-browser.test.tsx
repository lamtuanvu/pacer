import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser,type Page} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>;
type Values={'execution.local_max_tasks':number|string;'execution.local_memory_pressure_limit':string;'execution.local_load_limit':number|string};
const defaults:Values={'execution.local_max_tasks':'unlimited','execution.local_memory_pressure_limit':'critical','execution.local_load_limit':'off'};
let values:Values={...defaults},sets:unknown[]=[];
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
  if(op==='config.get')return Response.json({keys:{...Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,source:'user'}])),'execution.launch_mode':{value:'interactive',source:'default'},'terminal.open':{value:'',source:'default'},'terminal.app':{value:'Terminal',source:'default'}},terminalChoices:[{value:'auto',label:'Automatic'}],planners:[]});
  if(op==='config.set'){sets.push(params);const key=params.key as keyof Values,previous=values[key];values={...values,[key]:params.value};return Response.json({key,value:params.value,previous,diff:'',undo:`pacer config set ${key} ${previous}`});}
  return Response.json({});
 }});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
},15000);
afterAll(async()=>{await browser?.close();server?.stop(true);});

async function open(initial:Partial<Values>={}):Promise<Page>{
 values={...defaults,...initial};sets=[];
 const page=await browser.newPage();
 await page.goto(String(server.url));
 await page.getByRole('group',{name:'Parallel task limit'}).waitFor();
 return page;
}
const choice=(page:Page,group:string,name:string)=>page.getByRole('group',{name:group}).getByRole('button',{name});
const field=(page:Page)=>page.getByLabel('Parallel tasks on this machine');
const save=(page:Page)=>page.getByRole('button',{name:'Save changes'});
const error=(page:Page)=>page.getByText('Enter a whole number of at least 1.');

browserTest('no limit is the default and a hard cap is drafted, then saved only on Save',async()=>{
 const page=await open();
 try{
  expect(await choice(page,'Parallel task limit','No limit').getAttribute('aria-pressed')).toBe('true');
  expect(await field(page).count()).toBe(0);
  expect(await save(page).isDisabled()).toBe(true);
  await choice(page,'Parallel task limit','Limit to N').click();
  await field(page).fill('');
  await field(page).pressSequentially('24');
  expect(await field(page).inputValue()).toBe('24');
  expect(await page.getByText('Unsaved changes').count()).toBe(1);
  expect(sets).toEqual([]);
  await save(page).click();
  await page.getByText('All changes saved').waitFor({timeout:5000});
  expect(sets).toEqual([{key:'execution.local_max_tasks',value:24}]);
  expect(await field(page).inputValue()).toBe('24');
 }finally{await page.close();}
});

browserTest('switching an existing cap back to no limit saves unlimited',async()=>{
 const page=await open({'execution.local_max_tasks':2});
 try{
  expect(await field(page).inputValue()).toBe('2');
  await choice(page,'Parallel task limit','No limit').click();
  await save(page).click();
  await page.getByText('All changes saved').waitFor({timeout:5000});
  expect(sets).toEqual([{key:'execution.local_max_tasks',value:'unlimited'}]);
  expect(await field(page).count()).toBe(0);
 }finally{await page.close();}
});

browserTest('invalid parallel-task limits show an error and cannot be saved',async()=>{
 const page=await open({'execution.local_max_tasks':2});
 try{
  for(const text of ['0','1.5','']){
   await field(page).fill(text);
   expect(await field(page).inputValue()).toBe(text);
   await error(page).waitFor();
   expect(await save(page).isDisabled()).toBe(true);
  }
  // There is no upper ceiling on the local cap.
  await field(page).fill('40');
  expect(await error(page).count()).toBe(0);
  expect(await save(page).isEnabled()).toBe(true);
  expect(sets).toEqual([]);
 }finally{await page.close();}
});

browserTest('memory pressure and load limits are drafted together and saved through the save bar',async()=>{
 const page=await open();
 try{
  const picker=page.getByRole('button',{name:/Hold new tasks at memory pressure/});
  expect(await picker.textContent()).toContain('Critical');
  await picker.click();
  await page.getByRole('option',{name:'Warning'}).click();
  await choice(page,'Load limit','Limit').click();
  const load=page.getByLabel('Load limit per CPU core');
  await load.fill('0');
  await page.getByText('Enter a load per core greater than 0, such as 3.').waitFor();
  expect(await save(page).isDisabled()).toBe(true);
  await load.fill('2.5');
  expect(sets).toEqual([]);
  await save(page).click();
  await page.getByText('All changes saved').waitFor({timeout:5000});
  expect(sets).toEqual([{key:'execution.local_memory_pressure_limit',value:'warning'},{key:'execution.local_load_limit',value:2.5}]);
 }finally{await page.close();}
});

browserTest('Discard restores the saved machine settings',async()=>{
 const page=await open({'execution.local_max_tasks':2});
 try{
  await field(page).fill('9');
  await choice(page,'Load limit','Limit').click();
  await page.getByRole('button',{name:'Discard'}).click();
  expect(await field(page).inputValue()).toBe('2');
  expect(await choice(page,'Load limit','Off').getAttribute('aria-pressed')).toBe('true');
  expect(await page.getByText('All changes saved').count()).toBe(1);
  expect(sets).toEqual([]);
 }finally{await page.close();}
});
