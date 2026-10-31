import {beforeAll,afterAll,expect,test} from 'bun:test';
import {chromium,type Browser} from 'playwright-core';
import {join} from 'node:path';
import {tmpDir} from './helpers';
import type {Account} from '../app/src/model/accounts';
import {clock} from '../src/view-model/time';
const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser,server:ReturnType<typeof Bun.serve>,mode='unchanged',calls:{op:string;params:any}[]=[], snapshotAccounts:any[]=[];
const capability=(action:NonNullable<Account["usageCheck"]>["action"],description:string)=>({action,consentRequired:action==='probe',description});
const accounts:Account[]=[{name:'planner',kind:'claude',signedIn:true,runners:[],usageCheck:capability('probe','Runs a small task using account quota.'),usageReading:{windows:[],capturedAt:1799999000,stale:true}}, {name:'logs',kind:'codex',signedIn:true,usageCheck:capability('refresh','Reads available usage.')}, {name:'byteplus',kind:'endpoint',quotaSource:'arkcli',usageCheck:capability('refresh','Reads provider usage.')},{name:'reactive',kind:'cursor',usageCheck:capability('unsupported','Only limit hits are observable for this account.')},{name:'local',kind:'endpoint',usageCheck:capability('unmetered','Unmetered. This account has no quota to check.')}];
const job=(target:string,state='passed')=>({id:'check-'+target,kind:'account.usage.check',target,state,steps:[{name:'Check usage',state:state==='failed'?'failed':state==='running'?'running':'skipped',detail:state==='failed'?'Sign in to Ark CLI. arkcli exited 3: Live validation D3: UI fixture refuses execution':state==='running'?'Collecting telemetry':'No new usage observation. The previous reading is unchanged.'}],startedAt:1800000000,...(state==='failed'?{error:{code:'not_allowed',message:'Sign in to Ark CLI. arkcli exited 3: Live validation D3: UI fixture refuses execution'}}:{})});
beforeAll(async()=>{
 if(!browserPath)return;
 const out=tmpDir();const build=await Bun.build({entrypoints:['test/fixtures/account-usage-browser.tsx'],outdir:out,target:'browser'});if(!build.success)throw Error(String(build.logs));
 const script=await Bun.file(join(out,'account-usage-browser.js')).text();
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css'].map(p=>Bun.file(p).text()))).join('\n');
 server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
  const op=new URL(req.url).pathname.slice(5);if(!new URL(req.url).pathname.startsWith('/ops/'))return new Response(`<meta charset="utf-8"><div id="root"></div><style>${css}</style><script type="module">${script}</script>`,{headers:{'Content-Type':'text/html'}});
  const params=await req.json();calls.push({op,params});
  if(op==='fixture.snapshot')return Response.json(snapshotAccounts);
  if(op==='account.list')return Response.json(accounts);
  if(op==='config.get')return Response.json({keys:{},planners:[]});
  if(op==='job.list')return Response.json(mode==='poll-complete'?[job(params.target)]:[]);
  if(op==='account.usage.check'){
   if(mode==='network')return Response.json({message:'Connection lost. Try again.'},{status:503});
   return Response.json(job(params.account,mode==='running'?'running':mode==='failed'||params.account==='byteplus'?'failed':'passed'));
  }
  if(op==='job.get')return Response.json(job(params.id.replace('check-',''),mode==='running'?'running':'passed'));
  return Response.json({});
 }});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
},15000);
afterAll(async()=>{server?.stop(true);await browser?.close();});
browserTest('planner without executor asks consent, cancel spends nothing, confirmation checks the account',async()=>{
 calls=[];mode='unchanged';const page=await browser.newPage();try{
 await page.goto(String(server.url));const button=page.getByRole('button',{name:'Check usage for planner',exact:true});await button.click();
 await page.getByRole('dialog').getByText(/quota/).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 expect(calls.filter(c=>c.op==='account.usage.check')).toHaveLength(0);expect(await button.evaluate(el=>el===document.activeElement)).toBe(true);
 await button.click();await page.getByRole('button',{name:'Run usage check',exact:true}).click();
 await page.getByText('Reading unchanged.',{exact:true}).waitFor();
 expect(calls.filter(c=>c.op==='account.usage.check')).toEqual([{op:'account.usage.check',params:{account:'planner',consent:true}}]);
 }finally{await page.close();}
},15000);
browserTest('provider checks explain unchanged and auth failures; reactive and unmetered have no quota action',async()=>{
 mode='unchanged';calls=[];const page=await browser.newPage();try{
 await page.setViewportSize({width:1440,height:960});
 await page.goto(String(server.url));
 const fits=await page.getByRole('button',{name:'Check usage for logs',exact:true}).evaluate(el=>{const cell=el.closest('td')!.getBoundingClientRect(),box=el.getBoundingClientRect();return box.right<=cell.right&&box.left>=cell.left&&el.scrollWidth<=el.clientWidth;});expect(fits).toBe(true);
 await page.getByRole('button',{name:'Check usage for logs',exact:true}).click();
 await page.getByText('Reading unchanged.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Check usage for byteplus',exact:true}).click();await page.getByRole('button',{name:'Check usage for byteplus',exact:true}).locator('..').getByText('Usage check details').click();await page.getByText(/Sign in to Ark CLI/).waitFor();
 expect(await page.getByRole('button',{name:/Check usage for (local|reactive)/}).count()).toBe(0);
 await page.getByText('Only limit hits are observable for this account.').waitFor();await page.getByText('Unmetered. This account has no quota to check.').waitFor();
 await page.setViewportSize({width:375,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await page.close();}
},15000);
browserTest('running check disables duplicate clicks and network failures allow retry',async()=>{
 mode='running';calls=[];const page=await browser.newPage();try{
 await page.goto(String(server.url));const button=page.getByRole('button',{name:'Check usage for logs',exact:true});await button.click();await page.getByText('Checking usage…',{exact:true}).waitFor();expect(await button.isDisabled()).toBe(true);
 expect(calls.filter(c=>c.op==='account.usage.check')).toHaveLength(1);
 }finally{await page.close();}
 mode='network';calls=[];const retry=await browser.newPage();try{
 await retry.goto(String(server.url));const button=retry.getByRole('button',{name:'Check usage for logs',exact:true});await button.click();await retry.getByText('Couldn’t check usage. Try again.',{exact:true}).waitFor();await button.locator('..').getByText('Usage check details').click();await retry.getByText('Connection lost. Try again.',{exact:true}).waitFor();expect(await button.isDisabled()).toBe(false);
 mode='unchanged';await button.click();await retry.getByText('Reading unchanged.',{exact:true}).waitFor();
 }finally{await retry.close();}
},15000);

browserTest('one observation owns quota, window, reset, timestamp and stale state in either arrival order', async () => {
  mode = 'unchanged';
  const reading = accounts[0]!.usageReading!;
  const original = structuredClone(reading);
  const oldTime = 1700000000, newTime = 1800000000;
  const summary = {name:'planner', agent:'claude-code', source:'claude', usedPct:20, window:'week', resetsAt:1700003600, capturedAt:oldTime, stale:true, verdict:'unknown', signedIn:true, executors:[], spendUsdWeek:null, capUsdWeek:null};
  const page = await browser.newPage();
  const errors:string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    Object.assign(reading, {windows:[{name:'session',usedPct:80,resetsAt:newTime+3600}],capturedAt:newTime,stale:false});
    snapshotAccounts = [summary];
    await page.goto(String(server.url));
    const quota = page.locator('tr').filter({has:page.getByRole('button',{name:'Check usage for planner',exact:true})}).locator('[data-label="Quota"]');
    await quota.getByText(/80% of session/).waitFor();
    expect(await quota.innerText()).not.toContain('Stale');
    expect(await quota.innerText()).not.toContain('20%');
    expect(await quota.innerText()).toContain(`Last observed ${clock(newTime,Date.now()/1000)}`);
    expect(await quota.innerText()).toContain(`resets ${clock(newTime+3600,Date.now()/1000)}`);
    // A newer snapshot arrives after account.list; the entire display switches together.
    await page.evaluate(value => (window as any).setFixtureSnapshot(value), [{...summary,capturedAt:newTime+100,usedPct:40,stale:true}]);
    await quota.getByText(/40% of week/).waitFor();
    expect(await quota.innerText()).toContain('historical reading');
    expect(await quota.innerText()).toContain(`Last observed ${clock(newTime+100,Date.now()/1000)}`);
    expect(await quota.innerText()).toContain(`resets ${clock(summary.resetsAt,Date.now()/1000)}`);
    // Equal timestamps must retain a source failure rather than presenting false freshness.
    Object.assign(reading,{capturedAt:oldTime,stale:true,error:'Source temporarily unavailable'});
    snapshotAccounts = [{...summary,stale:false}];
    await page.goto(String(server.url));
    await quota.getByText(/80% of session/).waitFor();
    expect(await quota.innerText()).toContain('historical reading');
    await page.getByRole('button',{name:'Check usage for planner',exact:true}).locator('..').getByText('Usage check details').click();
    await page.getByText('Source temporarily unavailable',{exact:true}).waitFor();
    // The snapshot can age the same observation while account.list is still cached.
    Object.assign(reading,{stale:false,error:undefined});
    snapshotAccounts = [{...summary,stale:true}];
    await page.goto(String(server.url));
    await quota.getByText(/80% of session/).waitFor();
    expect(await quota.innerText()).toContain('historical reading');
    // Older services can omit usageReading entirely.
    delete accounts[0]!.usageReading;
    await page.goto(String(server.url));
    await quota.getByText(/20% of week/).waitFor();
    snapshotAccounts = [];
    await page.goto(String(server.url));
    await quota.getByText('No observation time available').waitFor();
    expect(errors).toEqual([]);
    accounts[0]!.usageReading = {...original,stale:false,windows:[{name:'week',usedPct:61,resetsAt:null}] as any,capturedAt:undefined};
    await page.goto(String(server.url));
    await quota.getByText(/61% of week/).waitFor();
    await quota.getByText('No observation time available').waitFor();
    expect(await quota.innerText()).toContain('Stale');
  } finally { accounts[0]!.usageReading = original; snapshotAccounts = []; await page.close(); }
}, 15000);
browserTest('lost SSE polling completes a running action and survives reload', async () => {
  mode = 'running'; calls = [];
  const page = await browser.newPage();
  try {
    await page.goto(String(server.url));
    const button = page.getByRole('button', {name:'Check usage for logs',exact:true});
    await button.click(); await page.getByText('Checking usage…',{exact:true}).waitFor();
    expect(await button.isDisabled()).toBe(true);
    mode = 'poll-complete';
    await button.locator('..').getByText('Reading unchanged.',{exact:true}).waitFor();
    await button.click({trial:true}); // Wait for the completed job's button update without dispatching another check.
    expect(await button.isDisabled()).toBe(false);
    await page.reload();
    await button.locator('..').getByText('Reading unchanged.',{exact:true}).waitFor();
    await button.click({trial:true}); // Wait for the completed job's button update without dispatching another check.
    expect(await button.isDisabled()).toBe(false);
  } finally { mode = 'unchanged'; await page.close(); }
}, 15000);

browserTest('new direct quota never shows an older green On pace status', async () => {
  const original = structuredClone(accounts[0]!);
  const page = await browser.newPage();
  try {
    accounts[0]!.usageReading = {windows:[{name:'week',usedPct:100,resetsAt:1800003600}],capturedAt:1800000100,stale:false};
    snapshotAccounts = [{name:'planner',agent:'claude-code',source:'claude',usedPct:20,window:'week',resetsAt:1800003600,capturedAt:1800000000,stale:false,verdict:'ON_PACE',pacePct:30,signedIn:true,executors:[],spendUsdWeek:null,capUsdWeek:null}];
    await page.goto(String(server.url));
    const row = page.locator('tr').filter({has:page.getByRole('button',{name:'Check usage for planner',exact:true})});
    await row.getByText(/100% of week/).waitFor();
    expect(await row.locator('[data-label="Status"]').innerText()).toContain('Usage observed');
    expect(await row.locator('[data-label="Status"] .pc-pill--good').count()).toBe(0);
    expect(await row.locator('.pc-meter__fill--neutral').count()).toBe(1);
    expect(await row.locator('.pc-meter__pace').count()).toBe(0);
  } finally { accounts[0] = original; snapshotAccounts = []; await page.close(); }
});
browserTest('untimestamped failed refresh keeps the error and labels retained quota historical', async () => {
  const original = structuredClone(accounts[0]!);
  const page = await browser.newPage();
  try {
    accounts[0]!.usageReading = {windows:[],capturedAt:null,stale:true,error:'Sign in again',availability:{state:'unknown',reason:'authentication_failed'}};
    snapshotAccounts = [{name:'planner',agent:'claude-code',source:'claude',usedPct:20,window:'week',resetsAt:1800003600,capturedAt:1800000000,stale:false,verdict:'ON_PACE',pacePct:30,signedIn:true,executors:[],spendUsdWeek:null,capUsdWeek:null}];
    await page.goto(String(server.url));
    const row = page.locator('tr').filter({has:page.getByRole('button',{name:'Check usage for planner',exact:true})});
    await row.getByText(/20% of week/).waitFor();
    expect(await row.innerText()).toContain('historical reading');
    expect(await row.innerText()).toContain(`Last observed ${clock(1800000000,Date.now()/1000)}`);
    expect(await row.locator('[data-label="Status"]').innerText()).toContain('Usage check failed');
    await row.getByText('Usage check details').click();
    await row.getByText('Sign in again', {exact:true}).waitFor();
    expect(await row.locator('.pc-meter__pace').count()).toBe(0);
  } finally { accounts[0] = original; snapshotAccounts = []; await page.close(); }
});
browserTest('matching timestamps retain the authoritative status and pace marker', async () => {
  const original = structuredClone(accounts[0]!);
  const page = await browser.newPage();
  try {
    accounts[0]!.usageReading = {windows:[{name:'week',usedPct:20,resetsAt:1800003600}],capturedAt:1800000000,stale:false};
    snapshotAccounts = [{name:'planner',agent:'claude-code',source:'claude',usedPct:20,window:'week',resetsAt:1800003600,capturedAt:1800000000,stale:false,verdict:'ON_PACE',pacePct:30,signedIn:true,executors:[],spendUsdWeek:null,capUsdWeek:null}];
    await page.goto(String(server.url));
    const row = page.locator('tr').filter({has:page.getByRole('button',{name:'Check usage for planner',exact:true})});
    await row.getByText(/20% of week/).waitFor();
    expect(await row.locator('[data-label="Status"]').innerText()).toContain('On pace');
    expect(await row.locator('.pc-meter__fill--good').count()).toBe(1);
    expect(await row.locator('.pc-meter__pace').getAttribute('style')).toContain('30');
  } finally { accounts[0] = original; snapshotAccounts = []; await page.close(); }
});
browserTest('summary-only, direct-only and missing observations render honest statuses without errors', async () => {
  const original = structuredClone(accounts[0]!);
  const page = await browser.newPage();
  const errors:string[] = []; page.on('pageerror',error=>errors.push(error.message));
  try {
    delete accounts[0]!.usageReading;
    snapshotAccounts = [{name:'planner',agent:'claude-code',source:'claude',usedPct:20,window:'week',resetsAt:null,capturedAt:1800000000,stale:false,verdict:'ON_PACE',pacePct:30,signedIn:true,executors:[],spendUsdWeek:null,capUsdWeek:null}];
    await page.goto(String(server.url));
    const row = page.locator('tr').filter({has:page.getByRole('button',{name:'Check usage for planner',exact:true})});
    await row.getByText(/20% of week/).waitFor();
    expect(await row.locator('[data-label="Status"]').innerText()).toContain('On pace');
    snapshotAccounts = [];
    accounts[0]!.usageReading = {windows:[{name:'week',usedPct:61,resetsAt:null}],capturedAt:1800000100,stale:false};
    await page.goto(String(server.url));
    await row.getByText(/61% of week/).waitFor();
    expect(await row.locator('[data-label="Status"]').innerText()).toContain('Usage observed');
    delete accounts[0]!.usageReading;
    await page.goto(String(server.url));
    await row.getByText('No observation time available').waitFor();
    expect(await row.locator('[data-label="Quota"]').innerText()).toContain('Usage unknown');
    expect(await row.locator('[data-label="Status"]').innerText()).not.toContain('On pace');
    expect(errors).toEqual([]);
  } finally { accounts[0] = original; snapshotAccounts = []; await page.close(); }
});

for (const width of [1440,375]) browserTest(`failed usage stays compact until details are opened in full Accounts at ${width}px`,async()=>{
  mode='failed'; calls=[];
  const original=structuredClone(accounts[0]!);
  const page=await browser.newPage({viewport:{width,height:960}});
  try {
    accounts[0]!.usageReading={windows:[],capturedAt:null,stale:true,error:'Sign in to Ark CLI. arkcli exited 3: Live validation D3: UI fixture refuses execution'};
    await page.goto(String(server.url));
    const button=page.getByRole('button',{name:'Check usage for planner',exact:true});
    const row=page.locator('tr').filter({has:button});
    const before=await row.evaluate(el=>el.getBoundingClientRect().height);
    await button.click();await page.getByRole('button',{name:'Run usage check',exact:true}).click();
    await row.getByRole('status').filter({hasText:'Couldn’t check usage. Try again.'}).waitFor();
    expect(await button.isDisabled()).toBe(false);
    const compact=await row.evaluate(el=>el.getBoundingClientRect().height);
    expect(compact).toBeLessThan(width===1440?180:600);
    expect(compact-before).toBeLessThan(70);
    expect(await row.locator('details').count()).toBe(1);
    expect(await row.locator('details').getAttribute('open')).toBe(null);
    expect(await row.innerText()).not.toContain('arkcli exited');
    expect(await row.innerText()).not.toContain('Live validation');
    expect(await page.locator('.pc-toasts').innerText()).toBe('');
    expect(await row.locator('.u3-progress,[role="alert"]').count()).toBe(0);
    expect(await row.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(await button.evaluate(el=>{const b=el.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth;})).toBe(true);
    const summary=row.locator('summary');await summary.focus();await page.keyboard.press('Enter');
    await row.getByText(/arkcli exited/).waitFor();
    expect(await row.getByText(/arkcli exited/).count()).toBe(1);
    expect(await row.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThan(compact);
    await summary.click();expect(await row.evaluate(el=>el.getBoundingClientRect().height)).toBe(compact);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  } finally {accounts[0]=original;mode='unchanged';await page.close();}
},15000);

browserTest('AccountUsage suppresses completion toasts while other useOperation consumers keep them',async()=>{
  const page=await browser.newPage();
  try {
    mode='unchanged';await page.goto(String(server.url)+'?default-operation');
    await page.getByRole('button',{name:'Check usage for logs',exact:true}).click();
    await page.getByText('Reading unchanged.',{exact:true}).waitFor();
    expect(await page.locator('.pc-toasts').innerText()).toBe('');
    await page.getByRole('button',{name:'Default operation'}).click();
    await page.locator('.pc-toasts').getByText('Check completed',{exact:true}).waitFor();
    mode='failed';await page.reload();
    await page.getByRole('button',{name:'Default operation'}).click();
    await page.locator('.pc-toasts').getByText('Check needs attention',{exact:true}).waitFor();
  } finally {mode='unchanged';await page.close();}
},15000);

browserTest('reactive and unmetered quota stays honest with synthetic reader and snapshot values', async () => {
  const originals = accounts.slice(3).map(account => structuredClone(account));
  const page = await browser.newPage();
  try {
    for (const [index, source] of [[3,'reactive'],[4,'unmetered']] as const) {
      const account = accounts[index]!;
      account.signedIn = true;
      account.usageReading = {source,windows:source==='reactive'?[{name:'limit',usedPct:0,resetsAt:null}]:[],capturedAt:1800000000,stale:true};
      snapshotAccounts.push({name:account.name,agent:account.kind,source,usedPct:0,window:'limit',resetsAt:null,capturedAt:1800000000,stale:true,verdict:source==='reactive'?'ON_PACE':'UNMETERED',pacePct:30,signedIn:true,executors:[],spendUsdWeek:null,capUsdWeek:null});
    }
    await page.goto(String(server.url));
    for (const [name, label] of [['reactive','Quota unavailable'],['local','Unmetered']]) {
      const row = page.locator('tr').filter({has:page.locator('[data-label="Quota"]').getByText(label!,{exact:true})});
      const quota = row.locator('[data-label="Quota"]');
      await quota.getByText(label!,{exact:true}).waitFor();
      expect(await quota.innerText()).toBe(label!);
      expect(await row.getByRole('meter').count()).toBe(0);
      expect(await row.locator('[data-label="Status"]').innerText()).not.toMatch(/Usage observed|Historical usage|On pace|Unmetered/);
      expect(await row.getByRole('button',{name:new RegExp(`Check usage for ${name}`)}).count()).toBe(0);
      expect(await row.locator('[data-label="Status"] .pc-pill--neutral').count()).toBe(1);
      expect(await row.innerText()).not.toMatch(/Last observed|No observation|No usage reported|Stale|check account usage/);
    }
  } finally {
    accounts.splice(3,2,...originals); snapshotAccounts=[]; await page.close();
  }
});

browserTest('expired snapshot quota shows a stale pill instead of its retained green verdict', async () => {
  const original = structuredClone(accounts[0]!);
  const page = await browser.newPage();
  try {
    delete accounts[0]!.usageReading;
    snapshotAccounts = [{name:'planner',agent:'claude-code',usedPct:17,window:'week',resetsAt:1800000000,capturedAt:1800000000,stale:false,verdict:'ON_PACE',signedIn:true}];
    await page.goto(String(server.url));
    const row = page.locator('tr').filter({has:page.getByRole('button',{name:'Check usage for planner',exact:true})});
    await row.getByText(/17% of week/).waitFor();
    expect(await row.locator('[data-label="Status"]').innerText()).toContain('Stale reading');
    expect(await row.locator('[data-label="Status"] .pc-pill--good').count()).toBe(0);
  } finally { accounts[0] = original; snapshotAccounts = []; await page.close(); }
});
