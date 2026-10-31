import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { generateTokensCss, readTokens } from '../app/tokens-gen';
const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
browserTest('NowCard shows at most two safe output lines and keeps acceptance and compact states distinct', async () => {
  const build = await Bun.build({entrypoints:['test/fixtures/trace-preview-browser.tsx'],target:'browser'});
  expect(build.success).toBe(true);
  const browser = await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
  const css = [generateTokensCss(readTokens('app/src/ds')), ...await Promise.all(['app/src/ds/components.css','app/src/styles.css','app/src/screens/trace/trace.css'].map(path=>Bun.file(path).text()))].join('\n');
  try {
    for (const settings of [{log:'user\nPACER_ROLE=executor: private instructions\nbrief echo\ncodex\nFirst\nEdited /home/developer/project/file.ts\nTesting /private/var/folders/xx/temp/T/check.ts'}, {log:'PACER_ROLE=executor: instructions\nDo not display the brief'}, {error:true}, {compact:true}, {task:{state:'failed',acceptance:{state:'failed',tail:'Failed acceptance check'}}}]) {
      const page = await browser.newPage({viewport:{width:1440,height:900}});
      await page.route('http://pacer.test/**', route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
      await page.goto('http://pacer.test');
      await page.evaluate(settings=>{(window as any).SETTINGS=settings;},settings);
      await page.addStyleTag({content:css});
      await page.addScriptTag({content:await build.outputs[0]!.text(),type:'module'});
      await page.getByRole('heading').waitFor();
      if ('compact' in settings || 'task' in settings) {
        if ('task' in settings) await page.getByLabel('Failed check output').waitFor();
        expect(await page.evaluate(()=>(window as any).CALLS)).toEqual([]);
      } else {
        await page.waitForFunction(()=>(window as any).CALLS.includes('task.log'));
        if ('error' in settings) await page.getByText('Could not load task output.').waitFor();
        else if (settings.log?.includes('First')) {
          const output=page.getByLabel('Task output',{exact:true});
          await output.waitFor();
          expect(await output.innerText()).toBe('Edited ~/project/file.ts\nTesting check.ts');
          for (const width of [1440,375]) {
            await page.setViewportSize({width,height:900});
            expect(await page.locator('body').evaluate(node=>node.scrollWidth<=innerWidth)).toBe(true);
            expect(await output.evaluate(node=>getComputedStyle(node).fontFamily)).toContain('mono');
          }
        } else expect(await page.getByLabel('Task output',{exact:true}).count()).toBe(0);
      }
      expect(await page.locator('body').innerText()).not.toContain('Unknown');
      expect(await page.locator('body').innerText()).not.toContain('PACER_ROLE');
      await page.close();
    }
  } finally {await browser.close();}
});
