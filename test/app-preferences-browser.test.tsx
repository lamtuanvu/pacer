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
  if(op==='config.set'){writes.push(params);terminal=params.value;return Response.json({});}
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
  await page.goto(String(server.url));
  const density=page.getByRole('group',{name:'Density',exact:true});
  await density.getByRole('button',{name:'Comfortable'}).click();
  expect(await page.evaluate(()=>localStorage.getItem('pacer.density'))).toBe('normal');
  expect(await page.evaluate(()=>(window as any).densityEvent)).toBe('normal');
  await page.reload();
  expect(await density.getByRole('button',{name:'Comfortable'}).getAttribute('aria-pressed')).toBe('true');
  await density.getByRole('button',{name:'Compact',exact:true}).click();
  expect(await page.evaluate(()=>localStorage.getItem('pacer.density'))).toBe('compact');
  expect(await page.getByRole('switch',{name:'Desktop banners'}).count()).toBe(0);
  expect(await page.getByRole('group',{name:'Terminal',exact:true}).count()).toBe(0);
  expect(await page.getByRole('link',{name:'Release notes',exact:true}).count()).toBe(1);
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
