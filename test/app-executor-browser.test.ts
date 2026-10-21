import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
const browserTest=test.skipIf(!process.env.PACER_TEST_BROWSER);
browserTest('executor draft survives refresh, validates, saves once and preserves focus',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 expect(built.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
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

browserTest('a delayed save acknowledgement cannot hide a newer client change',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/executor-editor.tsx'],target:'browser',minify:true});
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:await built.outputs[0].text()});
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
