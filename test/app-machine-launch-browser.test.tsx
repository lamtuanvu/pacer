import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser,type Page} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>;
const defaults:Record<string,unknown>={'execution.local_max_tasks':2,'execution.launch_mode':'interactive','terminal.open':''};
let values:Record<string,unknown>={...defaults},sets:unknown[]=[];
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
  if(op==='config.get')return Response.json({keys:{...Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,source:'default'}])),'terminal.app':{value:'Terminal',source:'default'}},terminalChoices:[{value:'auto',label:'Automatic'},{value:'ghostty',label:'Ghostty'}],planners:[]});
  if(op==='config.set'){sets.push(params);const previous=values[params.key];values={...values,[params.key]:params.value};return Response.json({key:params.key,value:params.value,previous,diff:'',undo:`pacer config set ${params.key} ${previous}`});}
  return Response.json({});
 }});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
},15000);
afterAll(async()=>{await browser?.close();server?.stop(true);});

async function open():Promise<Page>{
 values={...defaults};sets=[];
 const page=await browser.newPage();
 await page.goto(String(server.url));
 await page.getByRole('button',{name:/Delegated task launch/}).waitFor();
 return page;
}
const launch=(page:Page)=>page.getByRole('button',{name:/Delegated task launch/});
const terminal=(page:Page)=>page.getByRole('button',{name:/Terminal for sessions/});
const save=(page:Page)=>page.getByRole('button',{name:'Save changes'});
async function pick(page:Page,picker:ReturnType<typeof launch>,option:string){
 await picker.focus();
 await page.keyboard.press('Enter');
 await page.getByRole('option',{name:option}).click();
}

browserTest('delegated task launch and the preferred terminal are drafted and saved with the capacity fields',async()=>{
 const page=await open();
 try{
  expect(await launch(page).textContent()).toContain('Interactive');
  expect(await page.getByText(/finish when the agent reports its result/).count()).toBe(1);
  expect(await terminal(page).textContent()).toContain('Automatic');
  // The save bar follows the last row.
  expect(await page.evaluate(()=>{const bar=document.querySelector('.u3-save-bar')!,fields=[...document.querySelectorAll('.pc-setting-row')];return fields.length===6&&fields.every(f=>!!(f.compareDocumentPosition(bar)&Node.DOCUMENT_POSITION_FOLLOWING));})).toBe(true);
  await pick(page,launch(page),'Headless');
  await pick(page,terminal(page),'Ghostty');
  await page.getByRole('spinbutton',{name:'Parallel tasks',exact:true}).fill('3');
  expect(await page.getByText('Unsaved changes').count()).toBe(1);
  // Nothing saves silently: choosing writes nothing until Save.
  expect(sets).toEqual([]);
  await save(page).click();
  await page.getByText('All changes saved').waitFor({timeout:5000});
  expect(sets).toEqual([{key:'execution.local_max_tasks',value:3},{key:'execution.launch_mode',value:'headless'},{key:'terminal.open',value:'ghostty'}]);
  expect(await launch(page).textContent()).toContain('Headless');
  expect(await terminal(page).textContent()).toContain('Ghostty');
 }finally{await page.close();}
});

browserTest('Discard restores the launch mode and terminal',async()=>{
 const page=await open();
 try{
  await pick(page,launch(page),'Headless');
  await pick(page,terminal(page),'Ghostty');
  await page.getByRole('button',{name:'Discard'}).click();
  expect(await launch(page).textContent()).toContain('Interactive');
  expect(await terminal(page).textContent()).toContain('Automatic');
  expect(await page.getByText('All changes saved').count()).toBe(1);
  expect(sets).toEqual([]);
 }finally{await page.close();}
});

browserTest('a launch mode changed elsewhere is not overwritten by Save',async()=>{
 const page=await open();
 try{
  await pick(page,launch(page),'Headless');
  values={...values,'execution.launch_mode':'headless-elsewhere'};
  await save(page).click();
  await page.getByText('Your draft is preserved.',{exact:false}).waitFor({timeout:5000});
  expect(sets).toEqual([]);
  expect(values['execution.launch_mode']).toBe('headless-elsewhere');
 }finally{await page.close();}
});

browserTest('the task backend is drafted and saved through the save bar',async()=>{
 const page=await open();
 try{
  const backend=page.getByRole('button',{name:/Task backend/});
  expect(await backend.textContent()).toContain('Direct');
  await pick(page,backend,'Orca');
  expect(await page.getByText('Unsaved changes').count()).toBe(1);
  expect(sets).toEqual([]);
  await save(page).click();
  await page.getByText('All changes saved').waitFor({timeout:5000});
  expect(sets).toEqual([{key:'execution.backend',value:'orca'}]);
  expect(await backend.textContent()).toContain('Orca');
 }finally{await page.close();}
});
