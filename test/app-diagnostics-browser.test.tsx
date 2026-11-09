import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser,type Page} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>;
let mode='success', calls:{op:string;params:any}[]=[], reads=0, fixed=new Set<string>(), release:()=>void=()=>{};
let pending:Promise<void>=Promise.resolve();

const review={kind:'review',label:'Review and fix',op:'agent.preview',params:{agent:'codex'}};
const refresh={kind:'auto',label:'Refresh usage',op:'limits.refresh',params:{account:'codex#tse'}};
const updateFiles={kind:'auto',label:'Update files',op:'agent.connect',params:{agent:'cursor'},consent:true};
const signIn={kind:'user',label:'Sign in to Codex',op:'account.signin',params:{name:'codex'}};
const billing={kind:'user',label:'Open Claude billing',url:'https://claude.ai/settings/billing',secondary:{label:'Turn off Claude',op:'runner.block',params:{id:'claude-code',reason:'No active subscription'}}};
const agentTask={kind:'agent',label:'Fix with agent',op:'doctor.fix.delegate',params:{check:'CLI opencode',scope:'fix'}};
const internal={kind:'internal',label:'Restart pacer service',op:'service.install',consent:true};
const issues=[
 {name:'Usage codex#tse',level:'warn',detail:'stale usage',remedy:refresh},
 {name:'Integration freshness cursor',level:'warn',detail:'managed assets need refresh',remedy:updateFiles},
 {name:'Install codex#work',level:'warn',detail:'missing integration',remedy:review},
 {name:'Login codex',level:'warn',detail:'no login indicator',remedy:signIn},
 {name:'Usage claude-code',level:'warn',detail:'no active subscription',remedy:billing},
 {name:'CLI opencode',level:'fail',detail:'opencode --help failed',remedy:agentTask},
 {name:'Integration freshness claude-code',level:'warn',evidence:'unverified',detail:'plugin_unavailable: native process owner supervises plugin children',remedy:internal},
 {name:'Planner check claude-code',level:'warn',evidence:'unverified',detail:'plugin_unavailable: native process owner supervises plugin children',remedy:internal},
];
const report=()=>({checkedAt:1,planner:'codex#work',repairAvailable:true,checks:[
 ...issues.map(check=>fixed.has(check.name)?{name:check.name,level:'ok',detail:'fixed'}:check),
 {name:'Binary codex',level:'ok',detail:'installed'},
 {name:'Claude host invocation',level:'info',evidence:'unverified',detail:'No host evidence'},
]});
const opCalls=(...ops:string[])=>calls.filter(c=>ops.includes(c.op));
async function until(done:()=>boolean){for(let i=0;i<200&&!done();i++)await Bun.sleep(25);expect(done()).toBe(true);}
const idle=(page:Page)=>page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));

beforeAll(async()=>{
 if(!browserPath)return;
 const out=tmpDir();
 const built=Bun.spawn([process.execPath,'build','test/fixtures/diagnostics-browser.tsx','--target','browser','--outdir',out],{stdout:'pipe',stderr:'pipe'});
 if(await built.exited)throw Error(await new Response(built.stderr).text());
 const script=await Bun.file(join(out,'diagnostics-browser.js')).text();
 const styles=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css'].map(path=>Bun.file(path).text()))).join('\n');
 server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const path=new URL(req.url).pathname;
  if(!path.startsWith('/ops/'))return new Response(`<!doctype html><html lang="en"><title>Diagnostics</title><meta charset="utf-8"><div id="root"></div><style>${styles}</style><script type="module">${script}</script></html>`,{headers:{'Content-Type':'text/html'}});
  const op=path.slice(5),params=await req.json();calls.push({op,params});
  if(op==='doctor.run'){
   if(mode==='long')return Response.json({checkedAt:1,checks:Array.from({length:100},(_,i)=>({name:`CLI agent-${i}`,level:i<2?'fail':i<10?'warn':i===10?'info':'ok',evidence:i===10?'unverified':undefined,detail:i<10?'agent help is missing launch flags: --json':'Launch options supported',...(i<10?{remedy:{...agentTask,params:{check:`CLI agent-${i}`,scope:'fix'}}}:{})}))});
   reads++;
   if(mode==='recheck-error'&&reads>1)return Response.json({code:'internal',message:'Recheck unavailable'},{status:500});
   return Response.json(report());
  }
  if(op==='agent.preview'){
   if(mode==='preview-error')return Response.json({code:'internal',message:'Preview unavailable'},{status:500});
   const agent=params.agent;
   if(agent==='cursor')return Response.json({agent,files:['$HOME/.cursor/rules/pacer.mdc','$HOME/.cursor/hooks.json'],
    changes:[
     {path:'$HOME/.cursor/rules/pacer.mdc',change:'update',note:'Pacer updates its entries and keeps your edits.'},
     {path:'$HOME/.cursor/hooks.json',change:'update',note:'Pacer updates its entries and keeps your edits.'}],
    undo:`pacer uninstall ${agent}`,revision:`rev-${agent}`});
   return Response.json({agent,files:['$HOME/work/AGENTS.md'],
    changes:[
     {path:'$HOME/work/AGENTS.md',change:'restore',note:'Changed outside pacer; restored to the installed version'},
     {path:'$HOME/CLAUDE.md',change:'kept',note:'Yours. Pacer never edits it'}],
    undo:`pacer uninstall ${agent}`,revision:`rev-${agent}`,
    undoSnapshot:{revision:`rev-${agent}`,at:1,files:[{path:'$HOME/work/AGENTS.md',change:'restore'}]}});
  }
  if(op==='agent.connect'){
   if(mode==='hold')await pending;
   if(mode==='connect-error')return Response.json({code:'conflict',message:'The integration target changed after preview',hint:'Review a fresh repair preview before applying changes.'},{status:409});
   fixed.add(params.agent==='cursor'?'Integration freshness cursor':'Install codex#work');
   if(mode==='undo-unavailable')return Response.json({installed:[],undo:{available:false,reason:'too large to keep a copy'}});
   return Response.json({installed:[],undo:{available:true,revision:`rev-${params.agent}`}});
  }
  if(op==='agent.undo'){fixed.delete(params.agent==='cursor'?'Integration freshness cursor':'Install codex#work');return Response.json({restored:[],removed:[],reverted:[],kept:[]});}
  if(op==='routing.route')return Response.json({kind:'debug',ranked:[{id:'codex#team',reason:'22% of its budget used, with room this week'}]});
  if(op==='limits.refresh'){if(mode!=='refresh-stays')fixed.add('Usage codex#tse');return Response.json({});}
  if(op==='doctor.fix.delegate')return Response.json({task:{task_id:'t-fix-1',title:'Fix check',state:'queued'},check:params.check,scope:params.scope});
  return Response.json({});
 }});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
},15000);
afterAll(async()=>{await browser?.close();server?.stop(true);});

function reset(next='success'){calls=[];reads=0;mode=next;fixed=new Set();release=()=>{};}
async function open(options:{width?:number;scheme?:'light'|'dark'}={}){
 const page=await browser.newPage({viewport:{width:options.width??1440,height:900},colorScheme:options.scheme??'light'});
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{(window as any).copiedReport=text;}}});
 });
 await page.goto(String(server.url));
 await page.getByRole('button',{name:'Run all checks',exact:true}).click();
 await page.getByRole('heading',{name:/^Needs a fix/}).waitFor();
 return page;
}
async function axe(page:Page,scope='body'){
 await page.addScriptTag({path:'node_modules/axe-core/axe.min.js'});
 const violations=await page.evaluate(async selector=>{
  const result=await (window as any).axe.run(selector,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}});
  return result.violations.map((v:any)=>`${v.id}: ${v.nodes.map((n:any)=>n.target.join(' ')).join(', ')}`);
 },scope);
 expect(violations).toEqual([]);
}

browserTest('review remedies preview first, cancel without writes, apply that revision once and recheck',async()=>{
 reset();
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Review and fix/}).click();
  const sheet=page.getByRole('dialog',{name:'Reconnect Codex'});
  await sheet.waitFor();
  expect(calls.map(c=>c.op).filter(op=>op!=='plugin.list')).toEqual(['doctor.run','agent.preview']);
  expect(await sheet.getByText('1 file changes').count()).toBe(1);
  await sheet.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByText('No changes were made.',{exact:true}).waitFor();
  expect(opCalls('agent.connect')).toEqual([]);
  await page.getByRole('button',{name:/^Review and fix/}).click();
  await sheet.waitFor();
  mode='hold';pending=new Promise(resolve=>{release=resolve;});
  await sheet.getByRole('button',{name:'Apply and recheck',exact:true}).click();
  await sheet.getByRole('button',{name:'Fixing and rechecking…'}).waitFor();
  expect(await sheet.getByRole('button',{name:'Fixing and rechecking…'}).isDisabled()).toBe(true);
  expect(await page.getByRole('button',{name:'Run all checks',exact:true}).isDisabled()).toBe(true);
  release();
  await page.getByRole('dialog',{name:'Codex reconnected'}).getByText(/Updated 1 file and rechecked: Integration · Codex \(work\) passes\./).waitFor();
  expect(opCalls('agent.connect')).toEqual([{op:'agent.connect',params:{agent:'codex',consent:true,preview_revision:'rev-codex'}}]);
  expect(reads).toBe(2);
  await page.getByRole('button',{name:'Back to Diagnostics',exact:true}).click();
  const row=page.locator('.pc-diagnostic-row',{hasText:'Integration · Codex (work)'});
  await row.getByText('Fixed and rechecked just now.').waitFor();
  expect(await row.getByRole('button',{name:/^Review and fix/}).count()).toBe(0);
 }finally{release();await page.close();}
},15000);

browserTest('the review sheet shows per-file change pills, the 7-day note and undoes an applied fix',async()=>{
 reset();
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Review and fix/}).click();
  const sheet=page.getByRole('dialog',{name:'Reconnect Codex'});
  await sheet.waitFor();
  const changesList=sheet.locator('.pc-diagnostic-changes');
  await changesList.waitFor();
  expect(await changesList.getByText('Restore',{exact:true}).count()).toBe(1);
  expect(await changesList.getByText('Not touched',{exact:true}).count()).toBe(1);
  expect(await sheet.getByText('Changed outside pacer; restored to the installed version').count()).toBe(1);
  expect(await sheet.getByText('Yours. Pacer never edits it').count()).toBe(1);
  expect(await sheet.getByText(/You can undo this from Diagnostics for 7 days/).count()).toBe(1);
  expect(await sheet.getByText('1 file changes').count()).toBe(1);
  expect(opCalls('agent.undo')).toEqual([]);
  await sheet.getByRole('button',{name:'Apply and recheck',exact:true}).click();
  const done=page.getByRole('dialog',{name:'Codex reconnected'});
  await done.waitFor();
  expect(await done.getByText(/previous copies, so you can undo this from Diagnostics for 7 days/).count()).toBe(1);
  await done.getByRole('button',{name:'Undo',exact:true}).click();
  const confirm=page.getByRole('group',{name:'Undo the Integration · Codex (work) repair'});
  await confirm.waitFor();
  expect(await confirm.innerText()).toContain('AGENTS.md');
  await confirm.getByRole('button',{name:'Restore copies',exact:true}).click();
  await page.getByText(/undone/).waitFor();
  expect(opCalls('agent.undo')).toEqual([{op:'agent.undo',params:{agent:'codex',consent:true,preview_revision:'rev-codex'}}]);
  expect(reads).toBe(3);
  await page.getByRole('button',{name:/^Review and fix/}).waitFor();
 }finally{await page.close();}
},15000);

browserTest('the done sheet shows a reason and no Undo when the connect left nothing undoable (UI-13)',async()=>{
 reset('undo-unavailable');
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Review and fix/}).click();
  const sheet=page.getByRole('dialog',{name:'Reconnect Codex'});
  await sheet.waitFor();
  await sheet.getByRole('button',{name:'Apply and recheck',exact:true}).click();
  const done=page.getByRole('dialog',{name:'Codex reconnected'});
  await done.waitFor();
  await done.getByText(/Undo isn't available for this fix: too large to keep a copy/).waitFor();
  expect(await done.getByRole('button',{name:'Undo',exact:true}).count()).toBe(0);
  expect(opCalls('agent.undo')).toEqual([]);
 }finally{await page.close();}
},15000);

browserTest('Escape while the undo confirmation is open cancels it and clears the pending consent',async()=>{
 reset();
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Review and fix/}).click();
  const sheet=page.getByRole('dialog',{name:'Reconnect Codex'});
  await sheet.waitFor();
  await sheet.getByRole('button',{name:'Apply and recheck',exact:true}).click();
  const done=page.getByRole('dialog',{name:'Codex reconnected'});
  await done.waitFor();
  await done.getByRole('button',{name:'Undo',exact:true}).click();
  const confirm=page.getByRole('group',{name:'Undo the Integration · Codex (work) repair'});
  await confirm.waitFor();
  await page.keyboard.press('Escape');
  // The pending confirmation resolves as cancelled, the sheet closes and no undo runs.
  await page.getByText('No changes were made.',{exact:true}).waitFor();
  expect(await page.getByRole('dialog',{name:'Codex reconnected'}).count()).toBe(0);
  expect(opCalls('agent.undo')).toEqual([]);
 }finally{await page.close();}
},15000);

browserTest('the agent sheet names the executor pacer would route to, chosen by pacer',async()=>{
 reset();
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Fix with agent/}).click();
  const sheet=page.getByRole('dialog',{name:'Fix with agent'});
  await sheet.waitFor();
  await until(()=>opCalls('routing.route').length===1);
  expect(opCalls('routing.route')).toEqual([{op:'routing.route',params:{kind:'debug'}}]);
  await sheet.getByText(/Chosen by pacer: 22% of its budget used/).waitFor();
  expect(await sheet.getByText('Codex · team').count()).toBeGreaterThan(0);
  await sheet.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByText('No changes were made.',{exact:true}).waitFor();
 }finally{await page.close();}
},15000);

for(const failure of ['preview-error','connect-error','recheck-error'])browserTest(`review remedy shows ${failure} and allows recovery`,async()=>{
 reset(failure);
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Review and fix/}).click();
  if(failure!=='preview-error')await page.getByRole('button',{name:'Apply and recheck',exact:true}).click();
  const message=failure==='preview-error'?'Preview unavailable':failure==='connect-error'?'The integration target changed after preview':'Recheck unavailable';
  await page.getByText(message,{exact:false}).first().waitFor();
  if(failure!=='preview-error')expect(await page.getByRole('button',{name:'Apply and recheck',exact:true}).count()).toBe(0);
  expect(reads).toBe(failure==='recheck-error'?2:1);
  if(failure!=='preview-error')await page.getByRole('button',{name:'Cancel',exact:true}).click();
  mode='success';
  await page.getByRole('button',{name:'Run all checks',exact:true}).click();
  // The recheck-error apply did land, so a fresh run no longer lists the reconnect.
  if(failure==='recheck-error')await page.getByRole('heading',{name:'Needs a fix · 5'}).waitFor();
  else await page.getByRole('button',{name:/^Review and fix/}).waitFor();
 }finally{await page.close();}
},15000);

browserTest('fix-all asks once, naming the files, before any consent-gated change and then rechecks once',async()=>{
 reset();
 const page=await open();
 try{
  const fixAll=page.getByRole('button',{name:'Fix 2 issues automatically',exact:true});
  expect(await page.locator('.pc-btn--primary').count()).toBe(1);
  await fixAll.click();
  const confirm=page.getByRole('group',{name:'Update pacer’s files for Cursor'});
  await confirm.waitFor();
  expect(await confirm.innerText()).toContain('hooks.json');
  expect(opCalls('limits.refresh','agent.connect')).toEqual([]);
  await confirm.getByRole('button',{name:'Update files',exact:true}).click();
  await page.getByText('Automatic fixes finished and checks refreshed. Review any remaining issues.',{exact:true}).waitFor();
  expect(opCalls('limits.refresh','agent.connect')).toEqual([
   {op:'limits.refresh',params:{account:'codex#tse'}},
   {op:'agent.connect',params:{agent:'cursor',preview_revision:'rev-cursor',consent:true}},
  ]);
  expect(reads).toBe(2);
  expect(await fixAll.count()).toBe(0);
  expect(await page.getByRole('button',{name:'Run all checks',exact:true}).getAttribute('class')).toContain('pc-btn--primary');
  expect(await page.getByText('Fixed and rechecked just now.').count()).toBe(2);
 }finally{await page.close();}
},15000);

browserTest('a single automatic file update confirms inline and cancel sends nothing',async()=>{
 reset();
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Update files for/}).click();
  const confirm=page.getByRole('group',{name:'Update pacer’s files for Cursor'});
  await confirm.waitFor();
  await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByText('No changes were made.',{exact:true}).waitFor();
  expect(opCalls('agent.connect')).toEqual([]);
 }finally{await page.close();}
},15000);

browserTest('a fix whose recheck still fails says so in the row and the announcement',async()=>{
 reset('refresh-stays');
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Refresh usage/}).click();
  await page.getByText('Budget · Codex (tse): still failing after the fix. The new result is in the row.',{exact:true}).waitFor();
  const row=page.locator('.pc-diagnostic-row',{hasText:'Budget · Codex (tse)'});
  expect(await row.getByText('Still failing after the fix.',{exact:false}).count()).toBe(1);
  expect(await row.getByRole('button',{name:/^Refresh usage/}).count()).toBe(1);
  expect(reads).toBe(2);
 }finally{await page.close();}
},15000);

browserTest('user remedies sign in or open an allowed link and recheck when the window regains focus',async()=>{
 reset();
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Sign in to Codex/}).click();
  await until(()=>opCalls('account.signin').length===1);
  await idle(page);
  await page.locator('.pc-diagnostic-row',{hasText:'Sign-in indicator · Codex'}).getByText(/rechecking when you return/).waitFor();
  expect(opCalls('account.signin')).toEqual([{op:'account.signin',params:{name:'codex'}}]);
  expect(reads).toBe(1);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await until(()=>reads===2);
  await idle(page);
  await page.getByRole('button',{name:/^Turn off Claude/}).click();
  await until(()=>reads===3);
  expect(opCalls('runner.block')).toEqual([{op:'runner.block',params:{id:'claude-code',reason:'No active subscription'}}]);
 }finally{await page.close();}
},15000);

browserTest('the agent sheet starts a fix task with the chosen scope and links to it',async()=>{
 reset();
 const page=await open();
 try{
  await page.getByRole('button',{name:/^Fix with agent/}).click();
  const sheet=page.getByRole('dialog',{name:'Fix with agent'});
  await sheet.waitFor();
  expect(opCalls('doctor.fix.delegate')).toEqual([]);
  await sheet.getByRole('radio',{name:/Investigate only/}).click();
  await sheet.getByRole('button',{name:'Start fix task',exact:true}).click();
  const started=page.getByRole('dialog',{name:'Fix task started'});
  await started.waitFor();
  expect(opCalls('doctor.fix.delegate')).toEqual([{op:'doctor.fix.delegate',params:{check:'CLI opencode',scope:'investigate'}}]);
  expect(await started.getByRole('link',{name:'Open task'}).getAttribute('href')).toBe('#/tasks/t-fix-1');
  await started.getByRole('button',{name:'Back to Diagnostics',exact:true}).click();
  const row=page.locator('.pc-diagnostic-row',{hasText:'Compatibility · OpenCode'});
  await row.getByText('Fix task running').waitFor();
  expect(await row.getByRole('link',{name:/^Open task/}).getAttribute('href')).toBe('#/tasks/t-fix-1');
  expect(await row.getByRole('button',{name:/^Fix with agent/}).count()).toBe(0);
 }finally{await page.close();}
},15000);

browserTest('checks pacer could not run share one card; restart asks first and copy report backs it',async()=>{
 reset();
 const page=await open();
 try{
  const card=page.locator('.pc-diagnostic-internal');
  expect(await card.locator('li').allInnerTexts()).toEqual(['Integration freshness · Claude','Planner check · Claude']);
  expect(await page.locator('.pc-diagnostic-row',{hasText:'Planner check · Claude'}).count()).toBe(0);
  await card.getByRole('button',{name:'Restart pacer service',exact:true}).click();
  const confirm=card.getByRole('group',{name:'Restart the pacer service'});
  await confirm.waitFor();
  await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(opCalls('service.install')).toEqual([]);
  await card.getByRole('button',{name:'Restart pacer service',exact:true}).click();
  await card.getByRole('button',{name:'Restart',exact:true}).click();
  await page.getByText('The pacer service restarted and checks were refreshed.',{exact:true}).waitFor();
  expect(opCalls('service.install')).toEqual([{op:'service.install',params:{consent:true}}]);
  await card.getByRole('button',{name:'Copy report to send to pacer',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).copiedReport)).toContain('plugin_unavailable');
 }finally{await page.close();}
},15000);

const focused=(page:Page)=>page.evaluate(()=>{const el=document.activeElement as HTMLElement|null;return el&&el!==document.body?(el.getAttribute('aria-label')??el.textContent??'').trim():'<body>';});

browserTest('keyboard focus stays with the remedy through sheets and inline confirmations',async()=>{
 reset();
 const page=await open();
 try{
  await page.getByRole('button',{name:'Review and fix for Integration · Codex (work)'}).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'Reconnect Codex'}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('No changes were made.',{exact:true}).waitFor();
  expect(await focused(page)).toBe('Review and fix for Integration · Codex (work)');
  await page.getByRole('button',{name:'Fix with agent for Compatibility · OpenCode'}).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'Fix with agent'}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('No changes were made.',{exact:true}).waitFor();
  expect(await focused(page)).toBe('Fix with agent for Compatibility · OpenCode');
  await page.getByRole('button',{name:'Update files for Integration freshness · Cursor'}).focus();
  await page.keyboard.press('Enter');
  const confirm=page.getByRole('group',{name:'Update pacer’s files for Cursor'});
  await confirm.waitFor();
  expect(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label'))).toBe('Update pacer’s files for Cursor');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('Update files');
  await page.keyboard.press('Tab');
  expect(await focused(page)).toBe('Cancel');
  await page.keyboard.press('Enter');
  await page.getByText('No changes were made.',{exact:true}).waitFor();
  expect(await focused(page)).toBe('Update files for Integration freshness · Cursor');
  expect(opCalls('agent.connect')).toEqual([]);
  const restart=page.locator('.pc-diagnostic-internal').getByRole('button',{name:'Restart pacer service',exact:true});
  await restart.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('group',{name:'Restart the pacer service'}).waitFor();
  expect(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label'))).toBe('Restart the pacer service');
  await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  await page.getByText('No changes were made.',{exact:true}).waitFor();
  expect(await focused(page)).toBe('Restart pacer service');
  await page.getByRole('button',{name:'Fix 2 issues automatically',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('group',{name:'Update pacer’s files for Cursor'}).getByRole('button',{name:'Update files',exact:true}).click();
  await page.getByText('Automatic fixes finished and checks refreshed. Review any remaining issues.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.activeElement&&document.activeElement!==document.body);
  expect(await focused(page)).toBe('Run all checks');
 }finally{await page.close();}
},20000);

browserTest('board keeps keyboard disclosures, one primary action, clipboard backing and responsive geometry',async()=>{
 reset();
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 try{
  await page.addInitScript(()=>{
   Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{(window as any).copiedReport=text;}}});
  });
  await page.goto(String(server.url));
  expect(await page.getByRole('button',{name:'Copy report',exact:true}).count()).toBe(0);
  expect(await page.getByText(/Last run/).count()).toBe(0);
  await page.getByRole('button',{name:'Run all checks',exact:true}).click();
  await page.getByRole('heading',{name:/^Needs a fix · 6/}).waitFor();
  await page.getByRole('button',{name:'Copy report',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).copiedReport)).toContain('missing integration');
  expect(await page.evaluate(()=>(window as any).copiedReport)).toMatch(/took (?:<1|\d+)s/);
  expect(await page.locator('.pc-btn--primary').count()).toBe(1);
  expect(await page.locator('details[open]').count()).toBe(0);
  const summary=page.locator('.pc-diagnostic-row summary').first();
  await summary.focus();await page.keyboard.press('Enter');
  expect(await page.locator('.pc-diagnostic-row details').first().getAttribute('open')).not.toBeNull();
  expect(await page.locator('.pc-diagnostic-row details pre').first().innerText()).toContain('fix runs: limits.refresh account=codex#tse');
  expect(await page.locator('summary button,summary a').count()).toBe(0);
  expect(await page.locator('.pc-page').evaluate(node=>getComputedStyle(node).padding)).toBe('24px 32px 40px');
  expect(await page.locator('h1').evaluate(node=>{const style=getComputedStyle(node);return {size:style.fontSize,line:style.lineHeight,weight:style.fontWeight};})).toEqual({size:'28px',line:'34px',weight:'650'});
  const geometry=await page.locator('.pc-diagnostic-list--card').evaluate(node=>{
   const list=getComputedStyle(node),glyph=getComputedStyle(node.querySelector('.pc-diagnostic-glyph')!);
   return {radius:list.borderRadius,glyph:glyph.width};
  });
  expect(geometry).toEqual({radius:'12px',glyph:'20px'});
  await page.setViewportSize({width:375,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const titleBox=await page.locator('h1').boundingBox(),runBox=await page.getByRole('button',{name:'Run all checks',exact:true}).boundingBox();
  expect(runBox!.y).toBeGreaterThan(titleBox!.y+titleBox!.height);
 }finally{await page.close();}
},15000);

browserTest('long results scroll inside the workbench while the settings panel stays put',async()=>{
 reset('long');
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 try{
  await page.goto(String(server.url));
  await page.getByRole('button',{name:'Run all checks',exact:true}).click();
  await page.getByRole('heading',{name:'Needs a fix · 10'}).waitFor();
  expect(await page.locator('.pc-diagnostic-list--card .pc-diagnostic-row').count()).toBe(10);
  expect(await page.locator('.pc-diagnostic-row:visible').count()).toBe(10);
  expect(await page.locator('.pc-diagnostic-row pre').first().isVisible()).toBe(false);
  await page.getByText('Show all').first().click();
  expect(await page.locator('.pc-diagnostic-row:visible').count()).toBe(99);
  const work=page.locator('.pc-main-scroll');
  const panelY=(await page.locator('.pc-settings-nav').boundingBox())!.y;
  await work.hover();await page.mouse.wheel(0,2400);
  await page.waitForFunction(()=>document.querySelector('.pc-main-scroll')!.scrollTop>0);
  expect((await page.locator('.pc-settings-nav').boundingBox())!.y).toBe(panelY);
  await page.setViewportSize({width:375,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await page.close();}
},15000);

for(const scheme of ['light','dark'] as const)browserTest(`axe finds no WCAG A/AA violations on the board and both sheets (${scheme})`,async()=>{
 reset();
 const page=await open({scheme});
 try{
  await axe(page);
  await page.getByRole('button',{name:/^Update files for/}).click();
  await page.getByRole('group',{name:'Update pacer’s files for Cursor'}).waitFor();
  await axe(page,'.pc-diagnostic-confirm');
  await page.getByRole('group',{name:'Update pacer’s files for Cursor'}).getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByText('No changes were made.',{exact:true}).waitFor();
  await page.getByRole('button',{name:/^Review and fix/}).click();
  await page.getByRole('dialog',{name:'Reconnect Codex'}).waitFor();
  await axe(page,'.pc-side-dialog');
  await axe(page,'.pc-diagnostic-changes');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/^Fix with agent/}).click();
  await page.getByRole('dialog',{name:'Fix with agent'}).waitFor();
  await page.locator('.pc-diagnostic-route').waitFor();
  await axe(page,'.pc-side-dialog');
  await axe(page,'.pc-diagnostic-route');
 }finally{await page.close();}
},20000);

browserTest('axe finds no violations at narrow width',async()=>{
 reset();
 const page=await open({width:375});
 try{await axe(page);}finally{await page.close();}
},20000);

