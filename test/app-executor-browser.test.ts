import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
const browserTest=test.skipIf(!process.env.PACER_TEST_BROWSER);
browserTest('executor draft survives refresh, validates, saves once and preserves focus',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 expect(built.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
  await page.getByRole('button',{name:'Details for Codex',exact:true}).click();
  const input=page.getByRole('spinbutton',{name:'Parallel tasks for codex',exact:true}),save=page.getByRole('button',{name:'Save changes',exact:true});
  await input.fill('2');await page.getByRole('button',{name:'Move Claude Code · second up',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).executorFixture.writes())).toBe(0);
  expect(await page.evaluate(()=>document.activeElement?.closest('tr')?.textContent)).toContain('second');
  await input.focus();await page.evaluate(()=>(window as any).executorFixture.refresh());
  await page.waitForTimeout(50);expect(await input.inputValue()).toBe('2');expect(await input.evaluate(n=>n===document.activeElement)).toBe(true);
  await input.fill('0');expect(await save.isDisabled()).toBe(true);expect(await page.getByText('Enter a whole number from 1 to 16.',{exact:true}).count()).toBe(1);
  await input.fill('2');await save.click();await page.getByRole('status').filter({hasText:'Executor settings saved'}).waitFor();
  expect(await page.evaluate(()=>(window as any).executorFixture.writes())).toBe(1);
  expect(await page.evaluate(()=>(window as any).executorFixture.settings().order)).toEqual(['claude-code#second','codex']);
  expect(await page.getByText('Saved.',{exact:true}).count()).toBe(0);
  await input.fill('3');await page.evaluate(()=>(window as any).executorFixture.fail(true));await save.click();await page.getByRole('alert').filter({hasText:'Service unavailable'}).waitFor();expect(await input.inputValue()).toBe('3');
  await page.evaluate(()=>(window as any).executorFixture.external());await page.getByText('Settings changed elsewhere',{exact:true}).waitFor();expect(await input.inputValue()).toBe('3');expect(await save.isDisabled()).toBe(true);
  await page.getByRole('button',{name:'Discard',exact:true}).click();expect(await input.inputValue()).toBe('2');
  await input.fill('4');await page.evaluate(()=>(window as any).executorFixture.remove());
  await page.waitForTimeout(50);expect(await input.count()).toBe(1);expect(await input.inputValue()).toBe('4');
  await page.evaluate(()=>{void (window as any).executorFixture.leave();});await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Stay',exact:true}).click();expect(await input.inputValue()).toBe('4');
 }finally{await browser.close();}
},20000);

browserTest('the Takes work switch saves immediately, stays busy and reverts on failure',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
  await page.getByRole('button',{name:'Details for Codex',exact:true}).click();
  const toggle=page.getByRole('switch',{name:'Enable codex',exact:true}),save=page.getByRole('button',{name:'Save changes',exact:true});
  expect(await toggle.isChecked()).toBe(true);
  await page.evaluate(()=>(window as any).executorFixture.holdSave());
  await toggle.click();
  await page.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-busy')==='true');
  expect(await toggle.isDisabled()).toBe(true);
  expect(await save.count()).toBe(0); // The inactive save bar stays hidden.
  expect(await page.evaluate(()=>(window as any).executorFixture.writes())).toBe(1);
  expect(await page.evaluate(()=>(window as any).executorFixture.settings().runners[0].enabled)).toBe(false);
  await page.evaluate(()=>(window as any).executorFixture.release());
  await page.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-busy')==='false');
  expect(await toggle.isChecked()).toBe(false);
  expect(await save.count()).toBe(0); // The inactive save bar stays hidden.
  await page.evaluate(()=>(window as any).executorFixture.fail(true));
  await toggle.click();
  await page.getByRole('region',{name:'Codex details',exact:true}).getByRole('alert').filter({hasText:'Service unavailable'}).waitFor();
  expect(await toggle.isChecked()).toBe(false);
  expect(await save.count()).toBe(0); // The inactive save bar stays hidden.

 }finally{await browser.close();}
},20000);

browserTest('a delayed save acknowledgement cannot hide a newer client change',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
  await page.getByRole('button',{name:'Details for Codex',exact:true}).click();
  const input=page.getByRole('spinbutton',{name:'Parallel tasks for codex',exact:true}),save=page.getByRole('button',{name:'Save changes',exact:true});
  await input.fill('2');await page.evaluate(()=>(window as any).executorFixture.holdSave());await save.click();
  await page.waitForFunction(()=>(window as any).executorFixture.writes()===1);
  await page.evaluate(()=>(window as any).executorFixture.setLimit(5));
  await page.getByText('Settings changed elsewhere',{exact:true}).waitFor();
  await page.evaluate(()=>(window as any).executorFixture.release());
  await page.waitForTimeout(100);
  expect(await input.inputValue()).toBe('2');
  expect(await page.getByText('Unsaved changes',{exact:true}).count()).toBe(1);
  expect(await page.getByText('Settings changed elsewhere',{exact:true}).count()).toBe(1);
  expect(await page.evaluate(()=>(window as any).executorFixture.settings().runners[0].maxTasks)).toBe(5);
 }finally{await browser.close();}
},20000);

browserTest('stale health ranks cannot duplicate or lock the previous planner after configuration changes',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
  await page.getByRole('button',{name:'Details for Codex',exact:true}).waitFor();
  await page.evaluate(()=>(window as any).executorFixture.switchPlanner());await page.waitForTimeout(50);
  await page.getByRole('button',{name:'Details for Claude Code',exact:true}).click();
  expect(await page.getByRole('spinbutton',{name:'Parallel tasks for claude-code',exact:true}).count()).toBe(1);
  expect(await page.locator('tbody tr').count()).toBe(2);
 }finally{await browser.close();}
},20000);

browserTest('save controls clear the narrow navigation and desktop actions stay reachable',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:375,height:900}});
  await page.setContent('<div id="app"></div><nav class="pc-bottom-bar" aria-label="Bottom navigation">Navigation</nav>');
  await page.addStyleTag({content:(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/ds/feedback.css','app/src/styles.css'].map(path=>Bun.file(path).text()))).join('\n')});
  await page.evaluate(()=>document.body.classList.add('pc-app--narrow'));
  await page.addScriptTag({content:await built.outputs[0].text()});
  await page.getByRole('button',{name:'Details for Codex',exact:true}).click();
  await page.getByRole('spinbutton',{name:'Parallel tasks for codex',exact:true}).fill('2');
  const bounds=await page.evaluate(()=>({save:document.querySelector('.u3-save-bar')!.getBoundingClientRect().bottom,nav:document.querySelector('.pc-bottom-bar')!.getBoundingClientRect().top}));
  expect(bounds.save).toBeLessThanOrEqual(bounds.nav);
  await page.setViewportSize({width:1440,height:1100});await page.evaluate(()=>{document.body.classList.remove('pc-app--narrow');document.querySelector('.pc-bottom-bar')!.remove();});
  await page.locator('.u3-agents-scroll').evaluate(el=>{el.scrollLeft=el.scrollWidth;});
  const action=await page.evaluate(()=>({right:document.querySelector('th:last-child')!.getBoundingClientRect().right,edge:document.querySelector('.u3-table-wrap')!.getBoundingClientRect().right}));
  expect(action.right).toBeLessThanOrEqual(action.edge);
 }finally{await browser.close();}
},20000);

browserTest('Takes work preserves unsaved order and parallel tasks',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
  await page.getByRole('button',{name:'Details for Codex',exact:true}).click();
  const input=page.getByRole('spinbutton',{name:'Parallel tasks for codex',exact:true});
  await input.fill('4');await page.getByRole('button',{name:'Move Claude Code · second up',exact:true}).click();
  await page.getByRole('switch',{name:'Enable codex',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Executor settings saved'}).first().waitFor();
  expect(await input.inputValue()).toBe('4');
  expect(await page.locator('tbody tr').first().textContent()).toContain('second');
  expect(await page.evaluate(()=>(window as any).executorFixture.settings())).toEqual({revision:'2',order:['codex','claude-code#second'],runners:[{id:'codex',enabled:false,maxTasks:1},{id:'claude-code#second',enabled:true,maxTasks:1}]});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.waitForFunction(()=>(window as any).executorFixture.writes()===2);
  expect(await page.evaluate(()=>(window as any).executorFixture.settings().revision)).toBe('3');
 } finally {await browser.close();}
},20000);

browserTest('Escape and Close restore Details focus, Remove focuses Add agent',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
  const details=page.getByRole('button',{name:'Details for Codex',exact:true});
  await details.click();await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Codex details');await page.keyboard.press('Escape');
  await page.getByRole('region',{name:'Codex details',exact:true}).waitFor({state:'detached'});
  expect(await page.getByRole('region',{name:'Codex details',exact:true}).count()).toBe(0);
  expect(await details.evaluate(n=>n===document.activeElement)).toBe(true);
  await details.click();await page.getByRole('button',{name:'Close Codex details',exact:true}).click();
  expect(await details.evaluate(n=>n===document.activeElement)).toBe(true);
  await details.click();await page.getByRole('button',{name:'Remove agent',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Remove',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.textContent==='Add agent');
  expect(await details.count()).toBe(0);
 } finally {await browser.close();}
},20000);

browserTest('Takes work conflict reloads saved settings and preserves page edits',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
  await page.getByRole('button',{name:'Details for Codex',exact:true}).click();
  const input=page.getByRole('spinbutton',{name:'Parallel tasks for codex',exact:true}),toggle=page.getByRole('switch',{name:'Enable codex',exact:true});
  await input.fill('4');await page.evaluate(()=>(window as any).executorFixture.conflictNext());await toggle.click();
  await page.getByRole('region',{name:'Codex details',exact:true}).getByRole('alert').filter({hasText:'Settings changed elsewhere'}).waitFor();
  await page.getByRole('button',{name:'Reload saved settings',exact:true}).waitFor();
  expect(await input.inputValue()).toBe('4');expect(await toggle.isChecked()).toBe(true);
  expect(await page.getByRole('button',{name:'Save changes',exact:true}).isDisabled()).toBe(true);
  expect(await page.evaluate(()=>(window as any).executorFixture.writes())).toBe(1);
 } finally {await browser.close();}
},20000);
