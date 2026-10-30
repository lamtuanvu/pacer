import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { saveError } from '../app/src/ds/ImmediateSave';
const executable = process.env.PACER_TEST_BROWSER ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath());
test('save error reasons hide internal diagnostics', () => {
  expect(saveError({code:'forbidden',message:'Live validation D8: config.set changes the real user environment'}).message).toBe("Couldn't save: This change is blocked in the validation sandbox.");
  expect(saveError({code:'conflict',message:'revision mismatch'}).message).toContain('changed elsewhere');
  expect(saveError(new Error('Disk is full')).message).toBe("Couldn't save: Disk is full");
});
test.skipIf(!existsSync(executable))('immediate saves lock, announce success for 2s, roll back failures and commit sliders once', async () => {
  const build = await Bun.build({entrypoints:['test/fixtures/immediate-save-browser.tsx'],target:'browser'});
  if (!build.success) throw new AggregateError(build.logs);
  const script = await build.outputs[0]!.text();
  const css = (await Promise.all(['tokens.css','components.css','feedback.css'].map(file => Bun.file(`app/src/ds/${file}`).text()))).join('\n');
  const writes: unknown[] = []; let fail = false, release: (() => void) | undefined;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request) {
    if (new URL(request.url).pathname !== '/save') return new Response(`<style>${css}</style><div id="root"></div><script type="module">${script}</script>`,{headers:{'Content-Type':'text/html'}});
    writes.push(await request.json()); await new Promise<void>(resolve => {release=resolve;});
    return fail ? Response.json({code:'forbidden',message:'Live validation D8: config.set changes the real user environment'},{status:403}) : Response.json({});
  }});
  const browser = await chromium.launch({headless:true,executablePath:executable});
  try {
    const page = await browser.newPage(); await page.goto(String(server.url));
    const policy = page.locator('.pc-immediate-save').first();
    await page.getByRole('button',{name:'Two',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('.pc-immediate-save__control')?.getAttribute('aria-busy') === 'true');
    expect(await policy.locator('.pc-immediate-save__control').evaluate(el => getComputedStyle(el).opacity)).toBe('0.65');
    expect(await page.getByRole('button',{name:'One',exact:true}).isDisabled()).toBe(true);
    expect(await page.getByRole('button',{name:'Two',exact:true}).getAttribute('aria-pressed')).toBe('true');
    while (!release) await Bun.sleep(5); (release as () => void)();
    await policy.getByText('Saved',{exact:false}).waitFor();
    expect(writes).toEqual(['two']);
    expect(await policy.locator('.pc-immediate-save__status').evaluate(el => getComputedStyle(el).fontSize)).toBe('12px');
    await policy.locator('.pc-immediate-save__status').filter({hasText:'Saved'}).waitFor({state:'hidden',timeout:4000});
    fail=true; release=undefined;
    await page.getByRole('switch',{name:'Enabled',exact:true}).click();
    while (!release) await Bun.sleep(5); (release as () => void)();
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('switch',{name:'Enabled',exact:true}).isChecked()).toBe(false);
    expect(await page.getByRole('alert').innerText()).toBe("Couldn't save: This change is blocked in the validation sandbox.");
    expect(await page.getByText('Technical details').count()).toBe(1);
    expect(await page.getByText('Live validation D8: config.set changes the real user environment',{exact:true}).isVisible()).toBe(false);
    fail=false; release=undefined;
    const slider=page.getByRole('slider',{name:'Reserve'});
    await slider.focus(); await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight');
    expect(writes).toHaveLength(2);
    await page.keyboard.up('ArrowRight');
    while (!release) await Bun.sleep(5); (release as () => void)();
    await page.locator('.pc-immediate-save').last().getByText('Saved',{exact:false}).waitFor();
    expect(writes).toHaveLength(3);
    await slider.blur(); expect(writes).toHaveLength(3);
  } finally { release?.(); await browser.close(); server.stop(true); }
},15000);
