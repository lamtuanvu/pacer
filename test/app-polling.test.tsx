import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let bundle: string;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/polling-browser.tsx'], target: 'browser', format: 'iife' });
  if (!built.success) throw new AggregateError(built.logs);
  bundle = await built.outputs[0]!.text();
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
});
afterAll(async () => { await browser?.close(); });

async function mount(page: Page, screen: string) {
  await page.route('http://pacer.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div>' }));
  // Install before the screen mounts so every short/safety interval is under test control.
  await page.clock.install();
  await page.goto(`http://pacer.test/?screen=${screen}`);
  await page.addScriptTag({ content: bundle });
}

const count = (page: Page, op: string) => page.evaluate(o => (window as any).calls.filter((call: any) => call.op === o).length, op);
const settle = (page: Page) => page.waitForTimeout(250);
const setHidden = (page: Page, hidden: boolean) => page.evaluate(value => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
const plugin = async (page: Page, ui: boolean) => {
  await page.evaluate(withUi => (window as any).emit('plugin', { id: 'checklist', state: 'ready', error: null, ...(withUi ? { ui: {} } : {}) }), ui);
  await settle(page);
};

browserTest('WorkView reloads the timeline on a task event, not on plugin ui traffic or a short timer', async () => {
  const page = await browser.newPage();
  try {
    await mount(page, 'work');
    await page.locator('.pc-work-timeline').waitFor({ state: 'attached' });
    await settle(page);
    // F6: mounting starts exactly one paginated read, not one per tree-revision effect.
    expect(await count(page, 'dispatch.events')).toBe(1);
    await page.clock.runFor(1500);
    expect(await count(page, 'dispatch.events')).toBe(1);
    await plugin(page, true);
    expect(await count(page, 'dispatch.events')).toBe(1);
    await page.evaluate(() => (window as any).emit('task', { ...(window as any).snapshotTask, rev: 99, state: 'done' }));
    await settle(page);
    expect(await count(page, 'dispatch.events')).toBeGreaterThan(1);
  } finally { await page.close(); }
});

browserTest('JobList reloads once on mount and again only when a tracked job signature changes', async () => {
  const page = await browser.newPage();
  try {
    await mount(page, 'jobs');
    await settle(page);
    // F5: the initial useResource read is not duplicated by the signature effect.
    expect(await count(page, 'job.list')).toBe(1);
    await page.clock.runFor(1500);
    expect(await count(page, 'job.list')).toBe(1);
    await plugin(page, true);
    expect(await count(page, 'job.list')).toBe(1);
    await page.evaluate(() => (window as any).emit('job', { id: 'job-2', target: 'acct', kind: 'account.usage.check', state: 'running', startedAt: 2, steps: [] }));
    await settle(page);
    expect(await count(page, 'job.list')).toBeGreaterThan(1);
    const running = await count(page, 'job.list');
    await setHidden(page, true);
    await page.clock.runFor(31000);
    expect(await count(page, 'job.list')).toBe(running);
    await setHidden(page, false);
    await page.clock.runFor(31000);
    expect(await count(page, 'job.list')).toBeGreaterThan(running);
  } finally { await page.close(); }
});

browserTest('Setup FirstRun refreshes on a task rev event, not on plugin ui traffic or a short timer', async () => {
  const page = await browser.newPage();
  try {
    await mount(page, 'setup');
    await settle(page);
    expect(await count(page, 'task.get')).toBe(1);
    await page.clock.runFor(1500);
    expect(await count(page, 'task.get')).toBe(1);
    await plugin(page, true);
    expect(await count(page, 'task.get')).toBe(1);
    await page.evaluate(() => (window as any).emit('task', { ...(window as any).snapshotTask, rev: 99, state: 'done' }));
    await settle(page);
    expect(await count(page, 'task.get')).toBeGreaterThan(1);
    const afterEvent = await count(page, 'task.get');
    await setHidden(page, true);
    await page.clock.runFor(31000);
    expect(await count(page, 'task.get')).toBe(afterEvent);
    await setHidden(page, false);
    await page.clock.runFor(31000);
    expect(await count(page, 'task.get')).toBeGreaterThan(afterEvent);
  } finally { await page.close(); }
});

browserTest('Machines rereads config on a config event, ignores plugin ui traffic and pauses its live poll while hidden', async () => {
  const page = await browser.newPage();
  try {
    await mount(page, 'machines');
    await settle(page);
    // One resource read plus the immediate live guard poll.
    expect(await count(page, 'config.get')).toBe(2);
    await page.clock.runFor(1500);
    expect(await count(page, 'config.get')).toBe(2);
    await plugin(page, false);
    await plugin(page, true);
    expect(await count(page, 'config.get')).toBe(2);
    await page.evaluate(() => (window as any).emit('config', { area: 'config', at: 1 }));
    await settle(page);
    expect(await count(page, 'config.get')).toBe(3);
    const afterEvent = await count(page, 'config.get');
    await setHidden(page, true);
    await page.clock.runFor(11000);
    expect(await count(page, 'config.get')).toBe(afterEvent);
    await setHidden(page, false);
    await page.clock.runFor(6000);
    expect(await count(page, 'config.get')).toBeGreaterThan(afterEvent);
  } finally { await page.close(); }
});
