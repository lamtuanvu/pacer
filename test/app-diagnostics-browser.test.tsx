import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>;
let mode='success', calls:{op:string;params:any}[]=[], reads=0, release:()=>void=()=>{};
let pending:Promise<void>;
const report=(fixed=false)=>({checkedAt:1,planner:'codex#work',repairAvailable:true,checks:[
 {name:'Install codex#work',level:fixed?'ok':'warn',detail:'missing integration'},
 {name:'Binary codex',level:'ok',detail:'installed'},
]});
beforeAll(async()=>{
 if(!browserPath)return;
 const out=tmpDir();
 const built=Bun.spawn([process.execPath,'build','test/fixtures/diagnostics-browser.tsx','--target','browser','--outdir',out],{stdout:'pipe',stderr:'pipe'});
 if(await built.exited)throw Error(await new Response(built.stderr).text());
 const script=await Bun.file(join(out,'diagnostics-browser.js')).text();
 const styles=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css'].map(path=>Bun.file(path).text()))).join('\n');
 server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const path=new URL(req.url).pathname;
  if(!path.startsWith('/ops/'))return new Response(`<meta charset="utf-8"><div id="root"></div><style>${styles}</style><script type="module">${script}</script>`,{headers:{'Content-Type':'text/html'}});
  const op=path.slice(5),params=await req.json();calls.push({op,params});
  if(op==='doctor.run'){
   reads++;
   if(mode==='recheck-error'&&reads>1)return Response.json({code:'internal',message:'Recheck unavailable'},{status:500});
   return Response.json(report(reads>1));
  }
  if(op==='agent.preview'){
   if(mode==='preview-error')return Response.json({code:'internal',message:'Preview unavailable'},{status:500});
   return Response.json({agent:'codex',files:['$HOME/work/AGENTS.md'],undo:'pacer uninstall codex#work',revision:'reviewed-account'});
  }
  if(op==='agent.connect'){
   if(mode==='hold')await pending;
   if(mode==='connect-error')return Response.json({code:'conflict',message:'The integration target changed after preview',hint:'Review a fresh repair preview before applying changes.'},{status:409});
   return Response.json({installed:['$HOME/work/AGENTS.md']});
  }
  return Response.json({});
 }});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
},15000);
afterAll(async()=>{await browser?.close();server?.stop(true);});

browserTest('repair previews before consent, cancels without writes, prevents duplicate apply and rechecks',async()=>{
 calls=[];reads=0;mode='success';
 const page=await browser.newPage();
 try{
  await page.goto(String(server.url));
  await page.getByRole('button',{name:'Run all checks',exact:true}).click();
  await page.getByRole('button',{name:/^Repair/}).click();
  await page.getByRole('region',{name:'Repair preview'}).waitFor();
  expect(calls.map(c=>c.op)).toEqual(['doctor.run','agent.preview']);
  expect(await page.getByText('Changes saved',{exact:true}).count()).toBe(0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(calls.some(c=>c.op==='agent.connect')).toBe(false);
  await page.getByRole('button',{name:/^Repair/}).click();
  await page.getByRole('region',{name:'Repair preview'}).waitFor();
  mode='hold';pending=new Promise(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'Apply repair',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#diagnostics-progress')?.textContent?.includes('Repairing'));
  expect(await page.getByRole('button',{name:'Apply repair',exact:true}).isDisabled()).toBe(true);
  expect(await page.getByRole('button',{name:'Run all checks',exact:true}).isDisabled()).toBe(true);
  release();
  await page.getByText('Repair applied and checks refreshed. Review any remaining issues.',{exact:true}).waitFor();
  expect(calls.filter(c=>c.op==='agent.connect')).toEqual([{op:'agent.connect',params:{agent:'codex',consent:true,preview_revision:'reviewed-account'}}]);
  expect(reads).toBe(2);
  expect(await page.getByRole('button',{name:/^Repair/}).count()).toBe(0);
  expect(await page.locator('details[open]').count()).toBe(0);
 }finally{release();await page.close();}
},15000);

for(const failure of ['preview-error','connect-error','recheck-error'])browserTest(`repair shows ${failure} and allows recovery`,async()=>{
 calls=[];reads=0;mode=failure;
 const page=await browser.newPage();
 try{
  await page.goto(String(server.url));
  await page.getByRole('button',{name:'Run all checks',exact:true}).click();
  await page.getByRole('button',{name:/^Repair/}).click();
  if(failure!=='preview-error')await page.getByRole('button',{name:'Apply repair',exact:true}).click();
  const message=failure==='preview-error'?'Preview unavailable':failure==='connect-error'?'The integration target changed after preview':'Recheck unavailable';
  await page.getByText(message,{exact:false}).waitFor();
  if(failure==='connect-error')expect(await page.getByRole('button',{name:'Apply repair',exact:true}).count()).toBe(0);
  expect(reads).toBe(failure==='recheck-error'?2:1);
  mode='success';
  await page.getByRole('button',{name:'Run all checks',exact:true}).click();
  await page.locator('.pc-diagnostic-list').first().waitFor();
 }finally{await page.close();}
},15000);

browserTest('board rows retain keyboard disclosures, clipboard backing and responsive geometry',async()=>{
 calls=[];reads=0;mode='success';
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 try{
  await page.addInitScript(()=>{
   Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{(window as any).copiedReport=text;}}});
  });
  await page.goto(String(server.url));
  expect(await page.getByRole('button',{name:'Copy report',exact:true}).count()).toBe(0);
  expect(await page.getByText(/Configuration and fixture tests/).count()).toBe(0);
  expect(await page.getByText(/Last run/).count()).toBe(0);
  await page.getByRole('button',{name:'Run all checks',exact:true}).click();
  await page.locator('.pc-diagnostic-list').first().waitFor();
  await page.getByRole('button',{name:'Copy report',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).copiedReport)).toContain('missing integration');
  expect(await page.evaluate(()=>(window as any).copiedReport)).toMatch(/took (?:<1|\d+)s/);
  expect(await page.getByText(/Configuration and fixture tests/).count()).toBe(0);
  const summary=page.locator('.pc-diagnostic-row summary').first();
  await summary.focus();await page.keyboard.press('Enter');
  expect(await page.locator('.pc-diagnostic-row details').first().getAttribute('open')).not.toBeNull();
  expect(await page.locator('summary button,summary a').count()).toBe(0);
  expect(await page.locator('.pc-page').evaluate(node=>{const style=getComputedStyle(node);return {width:style.width,padding:style.padding};})).toEqual({width:'1440px',padding:'24px 32px 40px'});
  expect(await page.locator('#diagnostics h1').evaluate(node=>{const style=getComputedStyle(node);return {size:style.fontSize,line:style.lineHeight,weight:style.fontWeight};})).toEqual({size:'28px',line:'34px',weight:'650'});
  const geometry=await page.locator('.pc-diagnostic-totals').evaluate(node=>{
   const totals=getComputedStyle(node),glyph=getComputedStyle(node.querySelector('.pc-diagnostic-glyph')!);
   return {radius:totals.borderRadius,columns:node.children.length,glyph:glyph.width};
  });
  expect(geometry).toEqual({radius:'12px',columns:4,glyph:'26px'});
  await page.setViewportSize({width:375,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const titleBox=await page.locator('#diagnostics h1').boundingBox(),runBox=await page.getByRole('button',{name:'Run all checks',exact:true}).boundingBox();
  expect(runBox!.y).toBeGreaterThan(titleBox!.y+titleBox!.height);
 }finally{await page.close();}
},15000);
