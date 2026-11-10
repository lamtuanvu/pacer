import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { buildApp } from '../app/build';

const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
browserTest('managed status stays accessible and out of layout in both built surfaces and themes', async () => {
  const files = await buildApp();
  const fixtures: Record<string, string> = {};
  for (const [name, entry] of Object.entries({tray:'test/fixtures/ui/managed-tray.tsx', answer:'test/fixtures/ui/needs-you.tsx'})) {
    const build = await Bun.build({entrypoints:[entry], target:'browser'});
    if (!build.success) throw new AggregateError(build.logs);
    fixtures[name] = await build.outputs[0]!.text();
  }
  const server = Bun.serve({hostname:'127.0.0.1', port:0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/app/tray.js') return new Response(fixtures.tray, {headers:{'content-type':'text/javascript'}});
    if (path === '/fixture.js') return new Response(fixtures.answer, {headers:{'content-type':'text/javascript'}});
    if (path === '/answer') return new Response('<link rel="stylesheet" href="/app/app.css"><div id="fixture"></div><script type="module" src="/fixture.js"></script>', {headers:{'content-type':'text/html'}});
    const file = files.find(f => `/app/${f.path}` === path);
    if (file && path === '/app/tray.html') return new Response(file.text.replace('id="app"', 'id="fixture"').replace('<script src=', '<script type="module" src='), {headers:{'content-type':file.type}});
    return file ? new Response(file.text, {headers:{'content-type':file.type}}) : new Response('', {status:404});
  }});
  const browser = await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!, headless:true});
  try {
    for (const surface of ['tray','answer']) for (const theme of ['light','dark']) {
      const page = await browser.newPage({viewport:{width:surface === 'tray' ? 340 : 375,height:900}});
      page.setDefaultTimeout(5000);
      await page.addInitScript(() => { (window as any).actionMode = 'hold'; });
      await page.goto(`${server.url}${surface === 'tray' ? 'app/tray.html' : 'answer?managed'}`);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      if (surface === 'answer') { await page.getByRole('tab',{name:/Questions/}).click(); await page.getByRole('link',{name:'Answer',exact:true}).click(); await page.locator('textarea').fill('Answer'); }
      const selectors = surface === 'tray' ? ['.tray', '.tray-attention', '.tray-footer'] : ['.pc-side-dialog', '.pc-side-dialog__footer'];
      const geometry = async () => Promise.all(selectors.map(selector => page.locator(selector).evaluateAll(nodes => nodes.map(node => {
        const {x, y, width, height} = node.getBoundingClientRect();
        return {x, y, width, height};
      }))));
      const before = await geometry();
      expect(before.every(boxes => boxes.length > 0)).toBe(true);
      if (process.env.PACER_TEST_VISIBLE_STATUS) await page.addStyleTag({content: '.sr-only[role=status] { position: static !important; width: auto !important; height: auto !important; overflow: visible !important; clip: auto !important; }'});
      await page.getByRole('button',{name:surface === 'tray' ? 'Retry' : 'Send answer',exact:true}).click();
      const status = page.getByRole('status').filter({hasText:surface === 'tray' ? 'Working' : 'Sending'});
      await status.waitFor({state:'attached'});
      expect(await status.count()).toBe(1);
      expect(await geometry()).toEqual(before);
      const hidden = await status.evaluate(e => { const r=e.getBoundingClientRect(), s=getComputedStyle(e); return {width:r.width,height:r.height,position:s.position,overflow:s.overflow,clip:s.clip}; });
      expect(hidden.width).toBeLessThanOrEqual(1); expect(hidden.height).toBeLessThanOrEqual(1);
      expect(hidden.position).toBe('absolute'); expect(hidden.overflow).toBe('hidden'); expect(hidden.clip).toBe('rect(0px, 0px, 0px, 0px)');
      await page.close();
    }
  } finally { await browser.close(); server.stop(true); }
}, 30000);
