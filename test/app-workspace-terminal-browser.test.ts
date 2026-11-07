import { expect, test } from 'bun:test';
import { chromium, type Page } from 'playwright-core';
import { buildApp } from '../app/build';
import { mkdir } from 'node:fs/promises';

const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
const evidence = '.work/reviews/workspace-first-conflicts/terminal';

async function bundle(entrypoint = 'test/fixtures/workspace-browser.tsx') {
  const result = await Bun.build({
    entrypoints: [entrypoint], target: 'browser', format: 'esm', tsconfig: 'app/tsconfig.json',
    plugins: [{ name: 'eager-real-terminal', setup(builder) {
      builder.onResolve({ filter: /term\/LazyTerminal$/ }, () => ({ path: `${process.cwd()}/app/src/term/term.tsx` }));
      builder.onLoad({ filter: /app\/src\/term\/term.tsx$/ }, async args => ({
        contents: `/** @jsxImportSource preact */\n${await Bun.file(args.path).text()}\nexport { TerminalView as LazyTerminal };`, loader: 'tsx',
      }));
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs);
  return { js: await result.outputs[0]!.text(), css: (await buildApp()).find(file => file.path === 'app.css')!.text };
}

async function open(page: Page, source: Awaited<ReturnType<typeof bundle>>, held: boolean, theme: 'light' | 'dark', shell = false, heldSize = { cols: 240, rows: 60 }) {
  page.setDefaultTimeout(5000);
  await page.route('http://pacer.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div><div id="root"></div>' }));
  await page.goto('http://pacer.test/?header=1#/workspace?task=workspace-task');
  await page.evaluate(({ held, theme, heldSize }) => {
    document.documentElement.dataset.theme = theme;
    const history = Array.from({ length: 60 }, (_, i) => `Preserved history ${i}\r\n`).join('');
    const screen = '\x1b[97mAgent prompt\x1b[0m\r\n\x1b[38;2;180;190;210mTruecolor agent\x1b[0m\r\n\x1b[48;5;0m\x1b[97mIndexed black background\x1b[0m\r\n' + '\x1b[38;2;65;65;65mLow contrast agent\x1b[0m\r\n' + 'Full width output '.repeat(16);
    const sockets: any[] = [];
    class Socket {
      readyState = 1; binaryType = ''; sent: any[] = []; closed = false;
      onopen: any; onclose: any; onerror: any; onmessage: any;
      constructor(public url: string) {
        sockets.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      frame(frame: any) { this.onmessage?.({ data: JSON.stringify(frame) }); }
      send(value: any) {
        if (typeof value !== 'string') { this.sent.push({ input: [...new Uint8Array(value)] }); return; }
        const frame = JSON.parse(value); this.sent.push(frame);
        if (frame.type === 'hello') setTimeout(() => {
          if (frame.from !== undefined) this.frame({ type: 'control', controller: null, you: false });
          else {
            // A 1.1 host follows every snapshot with its control frame.
            this.frame({ type: 'snapshot', outputOffset: 0, cols: held ? heldSize.cols : 80, rows: held ? heldSize.rows : 24, scrollbackAnsi: history, screenAnsi: screen, controller: held ? 'other window' : null, viewers: 2 });
            this.frame({ type: 'control', controller: held ? 'other window' : null, you: false, versions: [1, 1], pacer: '0.13.0' });
          }
        }, 0);
        if (frame.type === 'take' && (!held || frame.force)) setTimeout(() => this.frame({ type: 'control', controller: 'app', you: true }), 0);
        if (frame.type === 'size') setTimeout(() => this.frame({ type: 'resize', cols: frame.cols, rows: frame.rows }), 0);
        if (frame.type === 'release') this.frame({ type: 'control', controller: null, you: false });
      }
      close() { this.closed = true; this.readyState = 3; }
      drop() { this.close(); this.onclose?.(); }
    }
    (window as any).WebSocket = Socket;
    (window as any).terminalSockets = sockets;
  }, { held, theme, heldSize });
  await page.addStyleTag({ content: source.css });
  await page.addStyleTag({ path: 'node_modules/@xterm/xterm/css/xterm.css' });
  await page.addScriptTag({ type: 'module', content: source.js });
  if (shell) await page.getByRole('button', { name: 'New terminal', exact: true }).click();
  await page.locator('.xterm-rows').first().waitFor();
  await page.waitForTimeout(500);
  if (held) await page.locator('.pc-terminal-pane').evaluate(node => { node.scrollTop = node.scrollHeight; });
}

browserTest('workspace watches until explicit control, preserves history/selection on handback and never resizes a hidden tab', async () => {
  const source = await bundle();
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, source, false, 'dark');
    expect(await page.evaluate(() => (window as any).terminalSockets[0].sent.filter((f: any) => ['take', 'size'].includes(f.type)))).toEqual([]);
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pc-terminal-view')?.getAttribute('data-session-control') === 'true', undefined, { timeout: 3000 });
    expect(await page.evaluate(() => (window as any).terminalSockets[0].sent.filter((f: any) => f.type === 'take'))).toEqual([{ type: 'take' }]);
    await page.locator('.xterm-helper-textarea').press('x');
    expect(await page.evaluate(() => (window as any).terminalSockets[0].sent.some((f: any) => f.input))).toBe(true);
    const size = await page.evaluate(() => (window as any).terminalSockets[0].sent.filter((f: any) => f.type === 'size').at(-1));
    expect(size.cols).toBeGreaterThan(40);
    expect(size.rows).toBeGreaterThan(24);
    const row = page.locator('.xterm-rows > div').first();
    await row.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); });
    const selection = await page.evaluate(() => getSelection()!.toString());
    await page.getByRole('button', { name: 'Hand back', exact: true }).click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).terminalSockets.length)).toBe(1);
    expect(await page.evaluate(() => getSelection()!.toString())).toBe(selection);
    expect(await page.locator('.xterm-rows').textContent()).toContain('Agent prompt');
    await page.evaluate(() => (window as any).terminalSockets[0].drop());
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => (window as any).terminalSockets[1].sent.filter((f: any) => f.type === 'take'))).toEqual([]);
    // Explicitly resume, then hide the tab behind a shell and resize the viewport.
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByRole('button', { name: 'Hand back', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Your shell · Fixture', exact: false }).first().click();
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => (window as any).terminalSockets[1].sent.filter((f: any) => f.type === 'size').length);
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as any).terminalSockets[1].sent.filter((f: any) => f.type === 'size').length)).toBe(before);
  } finally { await browser.close(); }
}, 60_000);

browserTest('occupied workspace sessions share the fill-pane layout, preserve lease and share a dark terminal palette in both themes', async () => {
  const source = await bundle();
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  const phase = process.env.PACER_CAPTURE_BASELINE ? 'before' : 'after';
  await mkdir(`${evidence}/${phase}`, { recursive: true });
  try {
    for (const viewport of [{ width: 2080, height: 1388 }, { width: 1440, height: 900 }, { width: 375, height: 900 }]) for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport, colorScheme: theme });
      await open(page, source, true, theme);
      await page.screenshot({ path: `${evidence}/${phase}/${viewport.width}-${theme}-occupied.png`, fullPage: true });
      if (process.env.PACER_CAPTURE_BASELINE) {
        await page.getByRole('button', { name: 'Take control', exact: true }).click();
        // Baseline driving image is a visual fixture: grant control after the explicit toolbar click.
        await page.waitForTimeout(300);
        await page.evaluate(() => (window as any).terminalSockets.at(-1).frame({ type: 'control', controller: 'app', you: true }));
        await page.getByRole('button', { name: 'Hand back', exact: true }).waitFor();
        await page.screenshot({ path: `${evidence}/${phase}/${viewport.width}-${theme}-driving.png`, fullPage: true });
        await page.close(); continue;
      }
      expect(await page.evaluate(() => (window as any).terminalSockets[0].sent.filter((f: any) => ['take', 'size'].includes(f.type)))).toEqual([]);
      const metrics = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.pc-terminal-pane')!;
        const mount = document.querySelector<HTMLElement>('.pc-terminal-mount')!;
        const screen = document.querySelector<HTMLElement>('.xterm-screen')!;
        const topbar = document.querySelector('.pc-topbar')!;
        const right = document.querySelector('.pc-side-panel--right') ?? document.querySelector('.pc-frame__right');
        const escaped = right ? [...right.querySelectorAll('*:not(.pc-panel-resize)')].filter(node => {
          const rect = node.getBoundingClientRect(), outer = right.getBoundingClientRect();
          return rect.width > 0 && (rect.right > outer.right + 1 || rect.left < outer.left - 1);
        }).length : 0;
        const paneBox = pane.getBoundingClientRect(), mountBox = mount.getBoundingClientRect();
        return {
          stripBottom: document.querySelector('.pc-terminal-strip')!.getBoundingClientRect().bottom,
          workspaceBottom: document.querySelector('.pc-workspace')!.getBoundingClientRect().bottom,
          transform: getComputedStyle(mount).transform,
          background: getComputedStyle(pane).backgroundColor,
          overflow: getComputedStyle(pane).overflow,
          fits: mountBox.width <= paneBox.width + 1 && mountBox.height <= paneBox.height + 1,
          screen: screen.getBoundingClientRect().width, mount: mountBox.width,
          documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
          actions: [...topbar.querySelectorAll('button,a,.pc-workspace-panel-details b,.pc-workspace-panel-details span')].filter(node => node.getBoundingClientRect().width > 0).map(node => ({label:node.getAttribute('aria-label')??node.textContent,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})),
          topbar: topbar.getBoundingClientRect().right, right: right?.getBoundingClientRect().right, escaped,
        };
      });
      expect(metrics.stripBottom).toBeLessThanOrEqual(metrics.workspaceBottom);
      // Watching never enlarges the PTY: a wide pane keeps natural size, a narrow one shrinks it to fit.
      const scale = metrics.transform === 'none' ? 1 : Number(/matrix\(([^,]+)/.exec(metrics.transform)![1]);
      expect(scale).toBeLessThanOrEqual(1);
      if (viewport.width === 375) expect(scale).toBeLessThan(1);
      expect(metrics.fits).toBe(true);
      expect(metrics.overflow).toBe('hidden');
      expect(metrics.background).toBe('rgb(0, 0, 0)');
      expect(metrics.documentWidth).toBe(metrics.viewport);
      expect(metrics.topbar).toBeLessThanOrEqual(viewport.width);
      if (metrics.right !== undefined) expect(metrics.right).toBe(viewport.width);
      expect(metrics.escaped).toBe(0);
      for (const action of metrics.actions) {
        expect(action.left, action.label??'header action').toBeGreaterThanOrEqual(0);
        expect(action.right, action.label??'header action').toBeLessThanOrEqual(viewport.width);
      }
      const color = await page.locator('.xterm-rows span').filter({ hasText: 'Low contrast agent' }).first().evaluate(node => getComputedStyle(node).color);
      const channels = color.match(/\d+/g)!.slice(0,3).map(Number).map(value => { const c=value/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4; });
      expect((channels[0]!*0.2126+channels[1]!*0.7152+channels[2]!*0.0722+0.05)/0.05).toBeGreaterThanOrEqual(4.5);
      const take = page.getByRole('button', { name: 'Take control', exact: true });
      expect(await take.getAttribute('class')).toContain('pc-btn--secondary');
      expect(await take.getAttribute('class')).not.toContain('pc-icon-button--bad');
      await take.click();
      await page.getByRole('dialog').waitFor();
      expect(await page.evaluate(() => (window as any).terminalSockets[0].sent.filter((f: any) => f.type === 'take'))).toEqual([]);
      await page.getByRole('dialog').getByRole('button', { name: 'Take control', exact: true }).click();
      await page.getByRole('button', { name: 'Hand back', exact: true }).waitFor();
      expect(await page.evaluate(() => (window as any).terminalSockets[0].sent.filter((f: any) => f.type === 'take'))).toEqual([{ type: 'take', force: true }]);
      const driving = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.pc-terminal-pane')!;
        const mount = document.querySelector<HTMLElement>('.pc-terminal-mount')!;
        const paneBox = pane.getBoundingClientRect(), mountBox = mount.getBoundingClientRect();
        return {
          transform: getComputedStyle(mount).transform,
          overflow: getComputedStyle(pane).overflow,
          fits: mountBox.width <= paneBox.width + 1 && mountBox.height <= paneBox.height + 1,
          you: document.querySelector('.pc-terminal-view')?.getAttribute('data-session-control') === 'true',
        };
      });
      expect(driving.you).toBe(true);
      expect(driving.transform).toBe('none');
      expect(driving.overflow).toBe('hidden');
      expect(driving.fits).toBe(true);
      await page.screenshot({ path: `${evidence}/${phase}/${viewport.width}-${theme}-driving.png`, fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
}, 60_000);


browserTest('a small watched PTY in a wide pane keeps its natural size instead of being enlarged', async () => {
  const source = await bundle();
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 2080, height: 1388 } });
    await open(page, source, true, 'light', false, { cols: 120, rows: 40 });
    const watched = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('.pc-terminal-pane')!;
      const mount = document.querySelector<HTMLElement>('.pc-terminal-mount')!;
      const paneBox = pane.getBoundingClientRect(), mountBox = mount.getBoundingClientRect(), pad = getComputedStyle(pane);
      return { transform: getComputedStyle(mount).transform, mount: mountBox.width, pane: paneBox.width,
        left: mountBox.left - paneBox.left - parseFloat(pad.paddingLeft), top: mountBox.top - paneBox.top - parseFloat(pad.paddingTop) };
    });
    expect(watched.transform).toBe('none');
    expect(watched.mount).toBeLessThan(watched.pane);
    expect(Math.abs(watched.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(watched.top)).toBeLessThanOrEqual(1);
    await page.close();
  } finally { await browser.close(); }
}, 30_000);

browserTest('explicitly controlled workspace reconnect resumes the same renderer and reacquires control without a forced take', async () => {
  const source = await bundle();
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, source, false, 'dark');
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByRole('button', { name: 'Hand back', exact: true }).waitFor();
    const renderer = await page.locator('.xterm').elementHandle();
    await page.evaluate(() => (window as any).terminalSockets[0].drop());
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as any).terminalSockets.length)).toBe(2);
    expect(await page.evaluate(() => (window as any).terminalSockets[1].sent.filter((f: any) => f.type === 'take'))).toEqual([{ type: 'take' }]);
    expect(await renderer!.evaluate(node => node.isConnected)).toBe(true);
    expect(await page.locator('.xterm-rows').textContent()).toContain('Agent prompt');
    expect(await page.locator('.pc-terminal-view').getAttribute('data-session-control')).toBe('true');
  } finally { await browser.close(); }
}, 30_000);

browserTest('real split shell renderers fit their own panes and keep the same terminal palette', async () => {
  const source = await bundle('test/fixtures/terminal-browser.tsx');
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
      await open(page, source, false, theme, true);
      const full = await page.evaluate(() => (window as any).terminalSockets[0].sent.filter((f: any) => f.type === 'size').at(-1));
      await page.getByRole('button', { name: 'Split terminal (⌘\\)' }).click();
      await page.waitForTimeout(500);
      expect(await page.locator('.xterm').count()).toBe(2);
      const sizes = await page.evaluate(() => (window as any).terminalSockets.map((s: any) => s.sent.filter((f: any) => f.type === 'size').at(-1)));
      for (const size of sizes) { expect(size.cols).toBeGreaterThan(1); expect(size.cols).toBeLessThan(full.cols); expect(size.rows).toBe(full.rows); }
      await page.screenshot({ path: `${evidence}/${process.env.PACER_CAPTURE_BASELINE ? 'before' : 'after'}/1440-${theme}-split.png`, fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
}, 45_000);
