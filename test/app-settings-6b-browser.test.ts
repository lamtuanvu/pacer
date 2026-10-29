import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
async function open(fn: (page: import('playwright-core').Page) => Promise<void>) {
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/add-host.tsx'], target: 'browser', minify: true });
  expect(built.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    await page.setContent('<div class="u3-settings" id="app"></div>');
    await page.addStyleTag({ content: (await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/ds/feedback.css','app/src/styles.css','app/src/screens/settings/settings.css'].map(path=>Bun.file(path).text()))).join('\n') });
    await page.addScriptTag({ content: await built.outputs[0]!.text() });
    await fn(page);
  } finally { await browser.close(); }
}
const calls = (page: import('playwright-core').Page) => page.evaluate(() => (window as any).hostFixture.calls() as [string, any][]);

browserTest('Add remote host: pick an alias, name it, then watch a live connect-and-check', async () => {
  await open(async page => {
    const connect = page.getByRole('button', { name: 'Connect and check', exact: true });
    expect(await connect.isDisabled()).toBe(true);
    expect(await page.getByText('Pick a host from your SSH config first.').count()).toBe(1);
    await page.locator('.u3-aliases').getByRole('button', { name: /^devbox(?:\s|$)/ }).click();
    // The name is suggested from the alias and can be edited; a taken name blocks the check with a reason.
    const name = page.getByRole('textbox', { name: /Name it in pacer/ });
    expect(await name.inputValue()).toBe('devbox');
    await name.fill('taken');
    expect(await connect.isDisabled()).toBe(true);
    await page.getByText('Another host already has this name.').waitFor();
    await name.fill('Bad Name');
    expect(await connect.isDisabled()).toBe(true);
    await name.fill('dev-1');
    await connect.click();
    await page.getByRole('status').filter({ hasText: 'dev-1 is connected' }).waitFor();
    expect((await calls(page)).map(([op]) => op).filter(op => op === 'host.add' || op === 'host.check')).toEqual(['host.add', 'host.check']);
    expect((await calls(page)).find(([op]) => op === 'host.add')![1]).toEqual({ alias: 'dev-1', ssh: 'devbox' });
    const list = page.getByRole('list', { name: 'Checks for dev-1' });
    expect(await list.getByRole('listitem').allTextContents()).toEqual(['✓Passed: Connects with your SSH key, no password prompt', '✓Passed: git 2.30 or newer2.47.0']);
    expect(await page.getByRole('link', { name: 'Map repositories' }).getAttribute('href')).toBe('#/settings/hosts/dev-1');
    expect(await connect.count()).toBe(0);
  });
}, 20000);

browserTest('a failed check names the reason and checks again without adding the host twice', async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).hostFixture.failFirst(true));
    await page.locator('.u3-aliases').getByRole('button', { name: /^pi-lab(?:\s|$)/ }).click();
    await page.getByRole('button', { name: 'Connect and check', exact: true }).click();
    await page.getByRole('button', { name: 'Check again', exact: true }).waitFor();
    expect(await page.getByRole('list', { name: 'Checks for pi-lab' }).textContent()).toContain('Failed: Connects with your SSH key');
    expect(await page.getByRole('link', { name: 'Map repositories' }).count()).toBe(0);
    expect(await page.getByRole('link', { name: 'Manage pi-lab', exact: true }).getAttribute('href')).toBe('#/settings/hosts/pi-lab');
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'pi-lab is connected' }).waitFor();
    expect((await calls(page)).filter(([op]) => op === 'host.add')).toHaveLength(1);
  });
}, 20000);

browserTest('Stepper moves focus with the arrow keys, Home and End, and selects with Enter', async () => {
  await open(async page => {
    const buttons = page.getByRole('list', { name: 'Wizard' }).getByRole('button');
    expect(await buttons.count()).toBe(3);
    await buttons.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    expect(await buttons.nth(1).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('End');
    expect(await buttons.nth(2).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await buttons.nth(2).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.locator('#picked').textContent()).toBe('2');
    expect(await page.locator('[aria-current="step"]').count()).toBe(1);
    expect(await page.getByText('D', { exact: true }).evaluate(n => n.closest('button'))).toBeNull();
  });
}, 20000);

async function openAgent(fn: (page: import('playwright-core').Page) => Promise<void>) {
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/add-agent.tsx'], target: 'browser', minify: true });
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    await page.addInitScript(() => { try { sessionStorage.clear(); } catch { /* none */ } });
    await page.setContent('<div class="u3-settings" id="app"></div>');
    await page.addStyleTag({ content: (await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/ds/feedback.css','app/src/styles.css','app/src/screens/settings/settings.css'].map(path=>Bun.file(path).text()))).join('\n') });
    await page.addScriptTag({ content: await built.outputs[0]!.text() });
    await fn(page);
  } finally { await browser.close(); }
}
const agentCalls = (page: import('playwright-core').Page) => page.evaluate(() => (window as any).agentFixture.calls() as [string, any][]);
const toStepFour = async (page: import('playwright-core').Page) => {
  await page.getByRole('button', { name: /Codex/ }).first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('radio', { name: /team/ }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
};

browserTest('Add agent: creates once with the chosen options, then is Ready only after the test task passes', async () => {
  await openAgent(async page => {
    await toStepFour(page);
    // The host link prefill reached step 3 (local was kept here), and the step heading took focus on arrival.
    await page.waitForFunction(() => document.activeElement?.textContent === 'Model, then a test task');
    await page.getByRole('button', { name: 'Tests', exact: true }).click();
    const add = page.getByRole('button', { name: 'Add agent and run test task' });
    await add.dblclick();
    await page.getByText('codex#team is ready.').waitFor();
    const adds = (await agentCalls(page)).filter(([op]) => op === 'runner.add');
    expect(adds).toHaveLength(1);
    expect(adds[0]![1]).toEqual({ agent: 'codex', account: 'team', host: 'devbox', kinds: ['tests'], max_tasks: 1, test: true });
    expect(await page.getByRole('link', { name: 'Open agents' }).getAttribute('href')).toBe('#/settings/executors');
    expect(await page.getByRole('button', { name: 'Add agent and run test task' }).count()).toBe(0);
  });
});

browserTest('Add agent: a failed test never shows Ready, can re-run, and the added agent can be removed', async () => {
  await openAgent(async page => {
    await page.evaluate(() => (window as any).agentFixture.outcome('failed'));
    await toStepFour(page);
    await page.getByRole('button', { name: 'Add agent and run test task' }).click();
    await page.getByRole('button', { name: 'Run test task again' }).waitFor();
    expect(await page.getByText(/is ready\./).count()).toBe(0);
    expect(await page.getByText('Not logged in').count()).toBeGreaterThan(0);
    expect(await page.getByRole('button', { name: 'Remove this agent' }).count()).toBe(1);
    await page.evaluate(() => (window as any).agentFixture.outcome('passed'));
    await page.getByRole('button', { name: 'Run test task again' }).click();
    await page.getByText('codex#team is ready.').waitFor();
    expect((await agentCalls(page)).filter(([op]) => op === 'runner.add')).toHaveLength(1);
    expect((await agentCalls(page)).filter(([op]) => op === 'runner.check')).toHaveLength(1);
  });
}, 20000);

browserTest('Add agent: Remove this agent asks first, removes the executor and returns to step 1', async () => {
  await openAgent(async page => {
    await page.evaluate(() => (window as any).agentFixture.outcome('failed'));
    await toStepFour(page);
    await page.getByRole('button', { name: 'Add agent and run test task' }).click();
    await page.getByRole('button', { name: 'Remove this agent' }).waitFor();
    await page.getByRole('button', { name: 'Remove this agent' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('heading', { name: 'Which agent?' }).waitFor();
    expect((await agentCalls(page)).find(([op]) => op === 'runner.remove')![1]).toEqual({ id: 'codex#team' });
  });
}, 20000);

browserTest('Add host: a check that cannot start is reported, not silently retried', async () => {
  await open(async page => {
    await page.locator('.u3-aliases').getByRole('button', { name: /^devbox(?:\s|$)/ }).click();
    await page.evaluate(() => (window as any).hostFixture.failFirst(true));
    await page.getByRole('button', { name: 'Connect and check', exact: true }).click();
    await page.getByRole('list', { name: 'Checks for devbox' }).waitFor();
    expect(await page.getByRole('status').filter({ hasText: /Changes saved/ }).count()).toBe(0);
  });
});

browserTest('Agents: the save bar is hidden at all widths until there is a draft, save or error', async () => {
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/executor-editor.tsx'], target: 'browser', minify: true });
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
    await page.setContent('<div class="u3-settings" id="app"></div>');
    await page.addStyleTag({ content: (await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/ds/feedback.css','app/src/styles.css','app/src/screens/settings/settings.css'].map(path=>Bun.file(path).text()))).join('\n') });
    await page.addStyleTag({ content: (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/ds/feedback.css', 'app/src/styles.css', 'app/src/screens/settings/settings.css'].map(path => Bun.file(path).text()))).join('\n') });
    await page.addScriptTag({ content: await built.outputs[0]!.text() });
    await page.getByRole('button', {name:'More actions for Codex',exact:true}).click();
    const input = page.getByRole('spinbutton', { name: 'Parallel tasks for codex', exact: true });
    await input.waitFor();
    const bar = page.locator('.u3-save-bar');
    expect(await bar.isVisible()).toBe(false);
    await input.fill('2');
    expect(await bar.isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    expect(await bar.isVisible()).toBe(false);
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await bar.isVisible()).toBe(false);
    const aside=await page.locator('.pc-page-columns__aside').evaluate(el=>({width:el.getBoundingClientRect().width,padding:getComputedStyle(el).padding}));
    expect(aside).toEqual({width:400,padding:'28px 24px'});
    expect(await page.locator('.pc-setting-row--stacked').count()).toBe(4);
    await input.fill('3');
    expect(await bar.isVisible()).toBe(true);
    await page.evaluate(() => (window as any).executorFixture.holdSave());
    await page.getByRole('button', {name:'Save changes',exact:true}).click();
    await page.waitForFunction(() => (window as any).executorFixture.writes()===1);
    expect(await bar.isVisible()).toBe(true);
    await page.evaluate(() => (window as any).executorFixture.release());
    await page.getByRole('button', {name:'Save changes',exact:true}).waitFor({state:'hidden'});
    await input.fill('4');
    await page.evaluate(() => (window as any).executorFixture.fail(true));
    await page.getByRole('button', {name:'Save changes',exact:true}).click();
    await page.getByText('Service unavailable', {exact:true}).waitFor();
    expect(await bar.isVisible()).toBe(true);
    await page.getByRole('button',{name:'Close Codex details',exact:true}).click();
    expect(await page.getByRole('button',{name:'More actions for Codex',exact:true}).evaluate(el=>el===document.activeElement)).toBe(true);
  } finally { await browser.close(); }
}, 20000);

browserTest('Accounts policy saves spread/fill and threshold through the existing config operations',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true,plugins:[{name:'account-policy',setup(builder){builder.onLoad({filter:/executor-editor\.tsx$/},()=>({loader:'tsx',resolveDir:process.cwd(),contents:`
 import {render} from 'preact';
 import {AccountPolicy} from '../../../app/src/screens/settings/Accounts';
 import {TaskContext} from '../../../app/src/screens/task-shared';
 import {ActionContext} from '../../../app/src/data/action-context';
 import {createActionRunner} from '../../../app/src/data/actions';
 import {initialState} from '../../../app/src/data/store';
 const config={keys:{'pacing.accounts':{value:'spread'},'pacing.fill_threshold':{value:80}},planners:[]};
 const calls=[];window.policyCalls=calls;
 const api={call:async(op,p)=>{if(op==='config.set'){calls.push([op,p]);config.keys[p.key]={value:p.value};return {};}return structuredClone(config);}};
 const actions=createActionRunner({call:api.call,waitFor:async()=>true,refetch:()=>{},navigate:()=>{}});
 render(<TaskContext.Provider value={{state:{...initialState(),connected:true},api}}><ActionContext.Provider value={actions}><AccountPolicy/></ActionContext.Provider></TaskContext.Provider>,document.getElementById('app'));
 `}));}}]});
 expect(built.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:375,height:1000}});await page.setContent('<div class="u3-settings" id="app"></div>');
  await page.addStyleTag({content:(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/ds/feedback.css','app/src/styles.css','app/src/screens/settings/settings.css'].map(path=>Bun.file(path).text()))).join('\n')});
  await page.addScriptTag({content:await built.outputs[0]!.text()});
  const spread=page.getByRole('radio',{name:'Spread evenly'}),fill=page.getByRole('radio',{name:'Fill one, then the next'});
  await spread.waitFor();expect(await spread.isChecked()).toBe(true);
  for(const radio of [spread,fill]) expect((await radio.locator('..').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await spread.focus();await page.keyboard.press('ArrowRight');
  await page.getByRole('spinbutton',{name:'Account fill threshold'}).waitFor();
  expect(await fill.isChecked()).toBe(true);
  const threshold=page.getByRole('spinbutton',{name:'Account fill threshold'});await threshold.fill('85');await threshold.press('Tab');
  await page.waitForFunction(()=>((window as any).policyCalls as any[]).length===2);
  expect(await page.evaluate(()=>(window as any).policyCalls)).toEqual([['config.set',{key:'pacing.accounts',value:'fill'}],['config.set',{key:'pacing.fill_threshold',value:85}]]);
  await spread.click();await threshold.waitFor({state:'hidden'});
 }finally{await browser.close();}
},20000);

browserTest('Agents failing row and detail render the real readiness message in board geometry',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true,plugins:[{name:'failing-agent',setup(builder){builder.onLoad({filter:/executor-editor\.tsx$/},async args=>({loader:'tsx',contents:(await Bun.file(args.path).text()).replace("state:'ready',slots","state:'failing',reason:'Endpoint returned 402',usedPct:45,pacePct:20,tone:'bad',slots")}));}}]});
 expect(built.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.setContent('<div id="app"></div>');
  await page.addStyleTag({content:(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/ds/feedback.css','app/src/styles.css'].map(path=>Bun.file(path).text()))).join('\n')});
  await page.addScriptTag({content:await built.outputs[0]!.text()});
  const row=page.locator('tbody tr').first();await row.waitFor();expect(await row.getAttribute('class')).toContain('u3-row--bad');
  expect(await row.evaluate(el=>getComputedStyle(el).boxShadow)).toContain('inset');
  await page.getByRole('button',{name:'More actions for Codex',exact:true}).click();
  const detail=page.getByRole('region',{name:'Codex details',exact:true});
  expect(await detail.locator('.pc-card--bad').textContent()).toContain('Endpoint returned 402');
  expect(await detail.locator('dt').allTextContents()).toEqual(['Account','Model','Runs on']);
  expect(await detail.getByRole('heading',{name:'Codex',exact:true}).evaluate(el=>{const c=getComputedStyle(el);return [c.fontSize,c.lineHeight,c.fontWeight];})).toEqual(['16px','22px','650']);
  expect(await detail.getByText('Removing keeps its task history.',{exact:true}).count()).toBe(1);
  expect(await detail.getByText('Pause this agent',{exact:true}).count()).toBe(0);
  await page.setViewportSize({width:768,height:1000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await browser.close();}
},20000);

browserTest('Machines board geometry, known capacity and narrow containment', async()=>{
 await open(async page=>{
  await emulateSettingsWidth(page,1440,1000);
  const cards=page.locator('.u3-machines-grid>.u3-machine-card');await cards.nth(1).waitFor();
  const geometry=await cards.evaluateAll(els=>els.map(el=>{const c=getComputedStyle(el);return {width:el.getBoundingClientRect().width,radius:c.borderRadius,overflow:c.overflow,border:c.borderTopWidth};}));
  expect(geometry[0]!.width).toBe(geometry[1]!.width);
  expect(geometry[0]).toMatchObject({radius:'12px',overflow:'hidden',border:'1px'});
  const rows=page.locator('.u3-machine-body .pc-setting-row--board');
  expect(await rows.count()).toBe(8);
  const layout=await rows.evaluateAll(els=>els.map(el=>{const c=getComputedStyle(el);return {width:el.getBoundingClientRect().width,columns:c.gridTemplateColumns,gap:c.gap,padding:c.padding};}));
  for (const row of layout) {
   expect(row.padding).toBe('12px 0px');
   // The board keeps the label and control side by side at desktop widths.
   expect(row.columns.split(' ')).toHaveLength(2);
   // The label yields to the control's 220px minimum within the full-width frame.
   expect(parseFloat(row.columns.split(' ')[0]!)).toBe(Math.min(240,row.width-20-220));
   expect(row.gap).toBe('20px');
  }
  expect(await page.locator('.u3-machines-grid').evaluate(el=>getComputedStyle(el).gap)).toBe('20px');
  expect(await page.getByRole('spinbutton',{name:'Parallel tasks',exact:true}).evaluate(el=>el.getBoundingClientRect().width)).toBe(72);
  // The select retains its 220px minimum after the label yields.
  expect(await page.getByRole('button',{name:'Terminal for sessions',exact:true}).evaluate(el=>el.getBoundingClientRect().width)).toBe(220);
  expect(await page.getByRole('heading',{name:'This Mac',exact:true}).evaluate(el=>{const c=getComputedStyle(el);return [c.fontSize,c.lineHeight,c.fontWeight]})).toEqual(['16px','22px','650']);
  expect(await page.getByText('Codex · team may use 3',{exact:true}).count()).toBe(1);
  await page.locator('.u3-aliases').getByRole('button', { name: /^devbox(?:\s|$)/ }).click();
  expect(await page.getByRole('textbox',{name:/Name it in pacer/}).evaluate(el=>el.getBoundingClientRect().width)).toBe(200);
  await page.getByRole('button',{name:'Connect and check',exact:true}).click();
  const checks=page.getByRole('list',{name:'Checks for devbox'});await checks.waitFor();
  expect(await checks.evaluate(el=>{const c=getComputedStyle(el);return [c.padding,c.gap,c.borderRadius]})).toEqual(['10px 12px','6px','8px']);
  await emulateSettingsWidth(page,375,343);
  expect(await page.locator('.u3-machines-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
},20000);

browserTest('Add agent board geometry, install guidance, radio keyboard choices and reported model selection',async()=>{
 await openAgent(async page=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.getByText('Install: install-cursor',{exact:true}).waitFor();
  expect(await page.getByRole('navigation',{name:'Breadcrumb'}).textContent()).toBe('Agents/Add an agent');
  expect(await page.locator('.pc-stepper').evaluate(el=>el.getBoundingClientRect().width)).toBe(230);
  expect(await page.locator('.pc-stepper').evaluate(el=>getComputedStyle(el).gap)).toBe('2px');
  expect(await page.locator('.u3-wizard').evaluate(el=>getComputedStyle(el).gap)).toBe('24px');
  expect(await page.locator('.u3-wizard-panel').evaluate(el=>{const c=getComputedStyle(el);return [c.padding,c.gap,c.borderRadius]})).toEqual(['20px 22px','16px','12px']);
  expect(await page.locator('.u3-agent-choices').evaluate(el=>getComputedStyle(el).gap)).toBe('10px');
  await page.getByRole('button',{name:/Codex/}).first().click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const account=page.getByRole('radio',{name:/team/});await account.focus();await page.keyboard.press('Space');expect(await account.isChecked()).toBe(true);
  expect(await account.locator('..').evaluate(el=>{const c=getComputedStyle(el);return c.borderColor===c.color})).toBe(true);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.textContent==='Where does it run?');
  const local=page.getByRole('radio',{name:/This Mac/});await local.focus();await local.press('Space');
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="agent-location"][value="local"]')?.checked);
  await local.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[name="agent-location"][value="remote"]')?.checked);expect(await page.getByRole('radio',{name:/A remote host/}).isChecked()).toBe(true);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const model=page.getByRole('button',{name:'Model',exact:true});expect(await model.evaluate(el=>el.getBoundingClientRect().width)).toBe(280);
  await model.click();await page.getByRole('option',{name:'Fixture model',exact:true}).click();
  await page.getByRole('button',{name:'Tests',exact:true}).click();
  expect(await page.getByRole('button',{name:'Tests',exact:true}).evaluate(el=>el.getBoundingClientRect().height)).toBe(28);
  await page.setViewportSize({width:375,height:1000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const testBlock=page.locator('.u3-test-task');
  expect(await testBlock.evaluate(el=>{const c=getComputedStyle(el);return [c.padding,c.borderRadius]})).toEqual(['14px','10px']);
  await testBlock.getByRole('button',{name:'Add agent and run test task'}).click();
  await page.getByText('codex#team is ready.').waitFor();
  expect((await agentCalls(page)).find(([op])=>op==='runner.add')![1].model).toBe('fixture-model');
 });
},20000);

browserTest('Add agent Check again reloads detection and exposes its busy state',async()=>{
 await openAgent(async page=>{
  await page.getByRole('button',{name:/Cursor/}).first().click();
  const check=page.getByRole('button',{name:'Check again',exact:true});
  await check.waitFor();
  const before=(await agentCalls(page)).filter(([op])=>op==='agent.detect').length;
  await page.evaluate(()=>{(window as any).agentFixture.install();(window as any).agentFixture.holdDetection();});
  await check.click();
  await page.waitForFunction(()=>document.querySelector('.u3-wizard-panel button[aria-busy="true"]'));
  expect(await check.getAttribute('aria-busy')).toBe('true');expect(await check.isDisabled()).toBe(true);
  await page.evaluate(()=>(window as any).agentFixture.releaseDetection());
  await page.getByRole('button',{name:'Continue',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('.u3-footer button.pc-btn--primary')?.hasAttribute('disabled'));
  expect((await agentCalls(page)).filter(([op])=>op==='agent.detect')).toHaveLength(before+1);
  await check.waitFor({state:'detached'});
  expect(await check.count()).toBe(0);
  expect(await page.locator('#agent-choice-cursor').evaluate(el=>el===document.activeElement)).toBe(true);
  expect(await page.getByRole('status').filter({hasText:'Cursor found'}).count()).toBe(1);
 });
},20000);

browserTest('failed host recovery keeps the current settings scope',async()=>{
 await open(async page=>{
  await page.evaluate(()=>{(window as any).hostFixture.scoped();(window as any).hostFixture.failFirst(true);});
  await page.locator('.u3-aliases').getByRole('button', { name: /^pi-lab(?:\s|$)/ }).click();
  await page.getByRole('button',{name:'Connect and check',exact:true}).click();
  const manage=page.getByRole('link',{name:'Manage pi-lab',exact:true});await manage.waitFor();
  const href=await manage.getAttribute('href');
  expect(href).toContain('#/settings/hosts/pi-lab?');expect(href).toContain('repo=fixture-repo');expect(href).toContain('scope=repo');
 });
},20000);

 browserTest('Check again keeps focus and the mounted button when no new agent is found',async()=>{
  await openAgent(async page=>{
   await page.getByRole('button',{name:/Cursor/}).first().click();
   const check=page.getByRole('button',{name:'Check again',exact:true});
   await page.evaluate(()=>(window as any).agentFixture.holdDetection());
   await check.click();
   await page.waitForFunction(()=>document.querySelector('.u3-actions button[aria-busy="true"]'));
   expect(await check.count()).toBe(1);
   await page.evaluate(()=>(window as any).agentFixture.releaseDetection());
   await page.waitForFunction(()=>document.activeElement?.textContent==='Check again' && !document.activeElement?.hasAttribute('disabled'));
   expect(await check.evaluate(el=>el===document.activeElement)).toBe(true);
  });
 },20000);

// These are the content widths left by the rail and Settings navigation, not viewport breakpoints.
const settingsWidths = [{viewport:1440, content:1000}, {viewport:768, content:476}, {viewport:375, content:343}];
async function emulateSettingsWidth(page: import('playwright-core').Page, viewport: number, content: number) {
  await page.setViewportSize({width:viewport,height:1000});
  await page.addStyleTag({content:`#app{width:${content}px;max-width:100%;padding:0;margin:0}#app>.u3-settings{width:100%;max-width:none;padding:0;margin:0}`});
}
async function assertContained(page: import('playwright-core').Page) {
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
browserTest('Add agent steps 1–4 fit the actual Settings container at desktop, tablet and phone widths', async()=>{
  for (const {viewport,content} of settingsWidths) {
    await openAgent(async page=>{
      await emulateSettingsWidth(page,viewport,content);
      await page.getByRole('heading',{name:'Which agent?',exact:true}).waitFor();
      for (let step=1;step<=4;step++) {
        await assertContained(page);
        const panel=await page.locator('.u3-wizard-panel').boundingBox();
        expect(panel!.width).toBeGreaterThanOrEqual(viewport===768?300:250);
        if (viewport!==1440) {
          const steps=await page.locator('.pc-stepper').boundingBox();
          expect(steps!.y+steps!.height).toBeLessThanOrEqual(panel!.y);
          expect(await page.locator('.pc-stepper').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
        }
        if(viewport===375) {
          for(const link of [page.getByRole('link',{name:'Cancel',exact:true}),page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Agents',exact:true})]) {
            const bounds = (await link.boundingBox())!;
            expect(bounds.width).toBeGreaterThanOrEqual(44);
            expect(bounds.height).toBeGreaterThanOrEqual(44);
          }
        }
        if(step===1) await page.getByRole('button',{name:/Codex/}).first().click();
        if(step===2) await page.getByRole('radio',{name:/team/}).check();
        if(step<4) await page.getByRole('button',{name:'Continue',exact:true}).click();
      }
      if(viewport===375) {
        for(const link of [page.getByRole('link',{name:'Cancel',exact:true}),page.getByRole('navigation',{name:'Breadcrumb'}).getByRole('link',{name:'Agents',exact:true})]) {
          expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
      }
    });
  }
},30000);

browserTest('Agents five columns and More actions remain contained with the aside and in narrow cards',async()=>{
  const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
  const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
  try {
    for(const {viewport,content} of settingsWidths) {
      const page=await browser.newPage();
      await page.setContent('<div id="app"></div>');
      await page.addStyleTag({content:(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/ds/feedback.css','app/src/styles.css','app/src/screens/settings/settings.css'].map(path=>Bun.file(path).text()))).join('\n')});
      await emulateSettingsWidth(page,viewport,content);
      await page.addScriptTag({content:await built.outputs[0]!.text()});
      const action=page.getByRole('button',{name:'More actions for Codex',exact:true});
      await action.click();
      expect(await page.locator('thead th').allTextContents()).toEqual(['Executor','Status','This week','Parallel','Actions']);
      expect(await page.locator('tbody tr').first().locator('td').count()).toBe(5);
      await assertContained(page);
      const edges=await page.locator('.u3-agents-table').evaluate(el=>({right:el.getBoundingClientRect().right,cells:[...el.querySelectorAll('td')].map(cell=>cell.getBoundingClientRect().right)}));
      for(const right of edges.cells) expect(right).toBeLessThanOrEqual(edges.right);
      // With the aside open at 1440 the table keeps the board's five columns instead of collapsing to cards.
      if(viewport===1440) {
        expect(await page.locator('thead').evaluate(el=>getComputedStyle(el).display)).not.toBe('none');
        await assertHeaderBand(page);
      }
      await action.scrollIntoViewIfNeeded();
      expect(await action.isVisible()).toBe(true);
      const bounds=await action.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(viewport);
      if(viewport===375) {
        const toggle=page.getByRole('switch',{name:'Enable codex',exact:true}).locator('..');
        const size=await toggle.boundingBox();expect(size!.width).toBeGreaterThanOrEqual(44);expect(size!.height).toBeGreaterThanOrEqual(44);
        expect((await page.getByRole('link',{name:'Dispatcher',exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await page.close();
    }
  } finally {await browser.close();}
},30000);

browserTest('Unknown host errors keep the settings frame and a scoped Machines destination',async()=>{
  const built=await Bun.build({entrypoints:['test/fixtures/ui/add-host.tsx'],target:'browser',minify:true,plugins:[{name:'unknown-host',setup(builder){builder.onLoad({filter:/add-host\.tsx$/},()=>({loader:'tsx',resolveDir:process.cwd(),contents:`
    import {render} from 'preact';
    import {HostDetail} from '../../../app/src/screens/settings/Hosts';
    import {TaskContext} from '../../../app/src/screens/task-shared';
    import {SettingsQueryContext} from '../../../app/src/screens/settings/shared';
    import {initialState} from '../../../app/src/data/store';
    import {ApiError} from '../../../app/src/data/api';
    const api={call:async()=>{throw new ApiError('invalid_input','unknown host missing');}};
    render(<TaskContext.Provider value={{state:{...initialState(),connected:true},api}}><SettingsQueryContext.Provider value={{repo:'fixture-repo',scope:'repo'}}><HostDetail alias="missing"/></SettingsQueryContext.Provider></TaskContext.Provider>,document.getElementById('app'));
  `}));}}]});
  expect(built.success).toBe(true);
  const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
  try {
    const page=await browser.newPage({viewport:{width:375,height:1000}});
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({content:(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/ds/feedback.css','app/src/styles.css'].map(path=>Bun.file(path).text()))).join('\n')});
    await page.addScriptTag({content:await built.outputs[0]!.text()});
    const heading=page.getByRole('heading',{name:'Host not found',level:1,exact:true});await heading.waitFor();
    expect(await heading.locator('xpath=ancestor::*[contains(@class,"pc-page")]').count()).toBe(1);
    const back=page.getByRole('link',{name:'Back to Machines',exact:true});
    expect(await back.getAttribute('href')).toContain('#/settings/machine?');
    expect(await back.getAttribute('href')).toContain('repo=fixture-repo');
    await assertContained(page);
  }finally{await browser.close();}
},20000);

async function assertHeaderBand(page: import('playwright-core').Page) {
  expect(await page.locator('thead tr').evaluate(el => getComputedStyle(el).borderBottomWidth)).toBe('1px');
  expect(await page.locator('thead tr').evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  for (const color of await page.locator('thead th').evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor))) {
    expect(color).toBe('rgba(0, 0, 0, 0)');
  }
}

browserTest('Accounts six board tracks, conditional actions and labelled cards fit their Settings container', async () => {
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/accounts-table.tsx'], target: 'browser', minify: true });
  expect(built.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    for (const { viewport, content } of settingsWidths) {
      const page = await browser.newPage();
      await page.setContent('<div id="app"></div>');
      await page.addStyleTag({ content: (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/ds/feedback.css', 'app/src/styles.css', 'app/src/screens/settings/settings.css'].map(path => Bun.file(path).text()))).join('\n') });
      await emulateSettingsWidth(page, viewport, content);
      await page.addScriptTag({ content: await built.outputs[0]!.text() });
      await page.locator('#accounts tbody tr').first().waitFor();
      expect(await page.locator('thead th').allTextContents()).toEqual(['Account', 'Sign-in', 'Quota', 'Status', 'Used by', 'Actions']);
      expect(await page.getByRole('button', { name: 'More actions for Codex · team', exact: true }).count()).toBe(0);
      expect(await page.locator('tbody tr').first().locator('td').count()).toBe(6);
      if (viewport === 1440) {
        const tracks = await page.locator('thead tr').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').map(parseFloat));
        expect(tracks).toHaveLength(6);
        expect(tracks[1]).toBe(130);
        expect(tracks[3]).toBe(150);
        expect(tracks[5]).toBe(32);
        console.log('Accounts tracks at 1000px content:', tracks.join('/'));
        await assertHeaderBand(page);
      } else {
        expect(await page.locator('thead').evaluate(el => getComputedStyle(el).display)).toBe('none');
        expect(await page.locator('tbody tr').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
      }
      const checkCells = async () => {
        await assertContained(page);
        const geometry = await page.locator('.u3-agents-table').evaluate(el => ({
          right: el.getBoundingClientRect().right,
          cells: [...el.querySelectorAll('td')].map(cell => ({ right: cell.getBoundingClientRect().right, fits: cell.scrollWidth <= cell.clientWidth })),
          text: [...el.querySelectorAll('td[data-label="Status"],td[data-label="Used by"]')].map(cell => {
            const range = document.createRange(); range.selectNodeContents(cell);
            return { text: cell.textContent, right: range.getBoundingClientRect().right, edge: cell.getBoundingClientRect().right };
          }),
        }));
        for (const cell of geometry.cells) {
          expect(cell.right).toBeLessThanOrEqual(geometry.right);
          expect(cell.fits).toBe(true);
        }
        for (const text of geometry.text) {
          expect(text.text!.trim().length).toBeGreaterThan(0);
          expect(text.right).toBeLessThanOrEqual(text.edge);
        }
      };
      await checkCells();
      const action = page.getByRole('button', { name: 'More actions for Codex · out', exact: true });
      await action.focus(); await page.keyboard.press('Enter');
      expect(await action.getAttribute('aria-expanded')).toBe('true');
      await page.getByText('Fix sign-in for Codex · out', { exact: true }).click();
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForFunction(() => (window as any).accountFixture.calls().some(([op, p]: any[]) => op === 'account.signin' && p.name === 'out'));
      await checkCells();
      await action.click();
      expect(await page.getByRole('button', { name: 'Sign in', exact: true }).isVisible()).toBe(false);
      await page.getByRole('button', { name: 'More actions for ark', exact: true }).click();
      await page.getByText('Fix Ark CLI sign-in for ark', { exact: true }).click();
      await page.getByRole('button', { name: 'Refresh usage for ark', exact: true }).click();
      await page.waitForFunction(() => (window as any).accountFixture.calls().some(([op, p]: any[]) => op === 'limits.refresh' && p.account === 'ark'));
      await checkCells();
      await page.close();
    }
  } finally { await browser.close(); }
}, 30000);
