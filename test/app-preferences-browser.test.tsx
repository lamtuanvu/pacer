import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>;
let level='all',terminal='ghostty';
const writes:{key?:string;value?:string;level?:string}[]=[];
beforeAll(async()=>{
 if(!browserPath)return;
 const out=tmpDir();
 const built=Bun.spawn([process.execPath,'build','test/fixtures/app-preferences-browser.tsx','--target','browser','--outdir',out],{stdout:'pipe',stderr:'pipe'});
 if(await built.exited)throw Error(await new Response(built.stderr).text());
 const script=await Bun.file(join(out,'app-preferences-browser.js')).text();
 const styles=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css'].map(path=>Bun.file(path).text()))).join('\n');
 server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const path=new URL(req.url).pathname;
  if(!path.startsWith('/ops/'))return new Response(`<meta charset="utf-8"><div id="root"></div><style>${styles}</style><script type="module">${script}</script>`,{headers:{'Content-Type':'text/html'}});
  const op=path.slice(5),params=await req.json();
  if(op==='config.get')return Response.json({keys:{'terminal.open':{value:terminal},update_check:{value:true}},terminalChoices:[{value:'auto',label:'Automatic'},{value:'ghostty',label:'Ghostty'}],planners:[]});
  if(op==='config.set'){writes.push(params);return Response.json({code:'forbidden',message:'D8 refuses config.set'},{status:403});}
  if(op==='notifications.get')return Response.json({level});
  if(op==='notifications.set'){writes.push(params);level=params.level;return Response.json({level});}
  if(op==='assistant.status')return Response.json({available:false,configured:false});
  if(op==='update.check')return Response.json({current:'0.11.0',latest:null,available:false,checkedAt:1793254320});
  if(op==='plugin.list')return Response.json([]);
  return Response.json({});
 }});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
},15000);
afterAll(async()=>{await browser?.close();server?.stop(true);});

browserTest('density persists and announces shell changes; App does not duplicate the terminal setting',async()=>{
 const page=await browser.newPage();
 try{
  await page.addInitScript(()=>{window.addEventListener('pacer:density',event=>{(window as any).densityEvent=(event as CustomEvent).detail;});});
  writes.length=0;
  await page.goto(String(server.url));
  const density=page.getByRole('group',{name:'Density',exact:true});
  expect(await density.getByRole('button',{name:'Comfortable'}).getAttribute('aria-pressed')).toBe('true');
  expect(await page.evaluate(()=>localStorage.getItem('pacer.density'))).toBeNull();
  await page.waitForFunction(()=>document.documentElement.dataset.density==='normal');
  const height=()=>page.locator('.pc-topbar__new').evaluate(el=>el.getBoundingClientRect().height);
  expect(await height()).toBe(32);
  expect(await page.getByRole('button',{name:'Density sample action'}).evaluate(el=>el.getBoundingClientRect().height)).toBe(32);
  expect(await page.locator('.pc-list-row').first().evaluate(el=>getComputedStyle(el).padding)).toBe('8px 12px');
  await density.getByRole('button',{name:'Compact',exact:true}).click();
  await density.getByRole('button',{name:'Comfortable'}).click();
  expect(await page.evaluate(()=>localStorage.getItem('pacer.density'))).toBe('normal');
  expect(await page.evaluate(()=>(window as any).densityEvent)).toBe('normal');
  await page.reload();
  expect(await density.getByRole('button',{name:'Comfortable'}).getAttribute('aria-pressed')).toBe('true');
  await density.getByRole('button',{name:'Compact',exact:true}).click();
  expect(await page.evaluate(()=>localStorage.getItem('pacer.density'))).toBe('compact');
  await page.waitForFunction(()=>document.documentElement.dataset.density==='compact');
  expect(await height()).toBe(28);
  expect(await page.getByRole('textbox',{name:'Touch sample input'}).evaluate(el=>el.getBoundingClientRect().height)).toBe(44);
  expect(await page.locator('.pc-list-row--touch').evaluate(el=>parseFloat(getComputedStyle(el).minHeight))).toBe(44);
  expect(await page.getByRole('button',{name:'Density sample action'}).evaluate(el=>el.getBoundingClientRect().height)).toBe(28);
  expect(await page.locator('.pc-list-row').first().evaluate(el=>getComputedStyle(el).padding)).toBe('6px 8px');
  await page.reload();
  expect(await density.getByRole('button',{name:'Compact',exact:true}).getAttribute('aria-pressed')).toBe('true');
  await page.waitForFunction(()=>document.documentElement.dataset.density==='compact');
  expect(await height()).toBe(28);
  await density.getByRole('button',{name:'Comfortable'}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.density==='normal');
  expect(await height()).toBe(32);
  const theme=page.getByRole('group',{name:'Theme',exact:true});
  for(const name of ['Dark','Light','System']) {
    await theme.getByRole('button',{name,exact:true}).click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe(name==='System'?null:name.toLowerCase());
    await page.reload();
    await theme.getByRole('button',{name,exact:true}).waitFor();
    expect(await theme.getByRole('button',{name,exact:true}).getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('html').getAttribute('data-theme')).toBe(name==='System'?null:name.toLowerCase());
  }
  expect(writes).toEqual([]);
  expect(await page.getByRole('switch',{name:'Desktop banners'}).count()).toBe(0);
  expect(await page.getByRole('group',{name:'Terminal',exact:true}).count()).toBe(0);
  await page.getByRole('link',{name:'Release notes',exact:true}).waitFor();
  expect(await page.getByText(/Once a day, in the background. Last checked .*\d{2}:\d{2}/).count()).toBe(1);
 }finally{await page.close();}
});

browserTest('desktop does not expose a banners switch backed by the global notification level',async()=>{
 level='all';writes.length=0;
 const page=await browser.newPage();
 try{
  await page.addInitScript(()=>{(window as any).__TAURI__={core:{invoke:async()=>null}};});
  await page.goto(String(server.url));
  await page.getByRole('button',{name:'Everything',exact:true}).waitFor();
  expect(await page.getByRole('switch',{name:'Desktop banners'}).count()).toBe(0);
  expect(level).toBe('all');
  expect(writes).toEqual([]);
 }finally{await page.close();}
});

browserTest('density rolls back and reports an inline error when persistence is denied',async()=>{
 const page=await browser.newPage();
 try{
  await page.addInitScript(()=>{Storage.prototype.setItem=()=>{throw new Error('storage denied');};});
  await page.goto(String(server.url));
  const density=page.getByRole('group',{name:'Density',exact:true});
  await density.getByRole('button',{name:'Compact',exact:true}).click();
  await page.getByRole('alert').filter({hasText:"Couldn't save: storage denied"}).waitFor();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  expect(await page.locator('.pc-topbar__new').evaluate(el=>el.getBoundingClientRect().height)).toBe(32);
  expect(await density.getByRole('button',{name:'Comfortable'}).getAttribute('aria-pressed')).toBe('true');
 }finally{await page.close();}
});
