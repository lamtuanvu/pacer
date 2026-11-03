import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

// Fresh `live up --seed ui` login only. No API/terminal substitutions or CSS overrides:
// a small fixture misses the real task list + output + wrapped-header stack.
const login = process.env.PACER_WORKSPACE_TEST_URL;
test.skipIf(!login || !process.env.PACER_TEST_BROWSER)('seeded live workspace task tabs are usable before any scrolling or focus', async () => {
  const url = new URL(login!);
  expect(url.hostname).toBe('127.0.0.1');
  expect(url.port).not.toBe('4317');
  const evidence = process.env.PACER_WORKSPACE_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const observations: unknown[] = [];
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true, timeout: 15000 });
  try {
    const context = await browser.newContext();
    const auth = await context.newPage();
    await auth.goto(login!);
    const tasks = await auth.evaluate(async () => {
      const response = await fetch('/v3/ops/task.list', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pacer-Client': 'app' }, body: JSON.stringify({ all: true, limit: 100 }) });
      if (!response.ok) throw Error('Sandbox task.list failed');
      return (await response.json()).result.tasks as { id: string; state: string }[];
    });
    const task = tasks.find(t => t.state === 'running');
    expect(task).toBeDefined();
    for (const theme of ['light', 'dark'] as const) for (const [width, height] of [[375, 900], [375, 667], [1440, 900]] as const) {
      const caseContext = await browser.newContext({ storageState: await context.storageState(), hasTouch: width === 375 });
      const page = await caseContext.newPage();
      page.setDefaultTimeout(5000);
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(`${url.origin}/app/#/workspace?task=${task!.id}`);
      await page.locator('.pc-workspace-task__body').waitFor();
      await page.locator('.pc-workspace-panel-details b').waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Loading session"]'));
      const tabs = page.getByRole('tablist', { name: 'Task details', exact: true });
      const metrics = () => tabs.evaluate(node => {
        const r = node.getBoundingClientRect();
        const nav = document.querySelector('.pc-bottom-bar')?.getBoundingClientRect();
        const header = document.querySelector('.pc-topbar')!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, navTop: nav?.top ?? innerHeight, headerBottom: header.bottom,
          contentTop: document.querySelector('.pc-workspace-task__body')!.getBoundingClientRect().top,
          scroll: document.querySelector('.pc-work')!.scrollTop, overflow: document.documentElement.scrollWidth > innerWidth,
          targets: [...node.querySelectorAll('[role="tab"]')].map(tab => {
            const b = tab.getBoundingClientRect();
            return { name: tab.textContent, height: b.height, hits: [b.top + 2, b.top + b.height / 2, b.bottom - 2].map(y => tab.contains(document.elementFromPoint(b.x + b.width / 2, y))) };
          }) };
      });
      const assertUsable = (m: Awaited<ReturnType<typeof metrics>>) => {
        expect(m.top).toBeGreaterThanOrEqual(m.headerBottom - 1);
        expect(m.bottom).toBeLessThanOrEqual(m.navTop);
        expect(m.overflow).toBe(false);
        for (const t of m.targets) { expect(t.height).toBeGreaterThanOrEqual(width === 375 ? 44 : 28); expect(t.hits).toEqual([true, true, true]); }
      };
      // No click, focus, trial click or scrollIntoView may precede these assertions.
      const initial = await metrics();
      if (evidence) await page.screenshot({ path: `${evidence}/${width}-${height}-${theme}-initial.png` });
      observations.push({ width, height, theme, initial });
      assertUsable(initial);
      expect(initial.scroll).toBe(0);
      if (width === 375) {
        for (const name of ['Changes', 'Notes', 'Overview']) {
          const tab = tabs.getByRole('tab', { name, exact: true });
          const box = (await tab.boundingBox())!;
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          expect(await tab.getAttribute('aria-selected')).toBe('true');
          assertUsable(await metrics());
        }
      }
      if (width === 375) {
        await page.mouse.move(180, height / 2);
        await page.mouse.wheel(0, 300);
        await page.waitForFunction(top => document.querySelector('.pc-workspace-task__body')!.getBoundingClientRect().top < top - 50, initial.contentTop);
        const scrolled = await metrics();
        assertUsable(scrolled);
        observations.push({ width, height, theme, scrolled });
        if (evidence) await page.screenshot({ path: `${evidence}/${width}-${height}-${theme}-scroll.png` });
      }
      // Native traversal, not locator.focus(), also has to reveal the complete row.
      await page.reload();
      await page.locator('.pc-workspace-task__body').waitFor();
      let reached = false;
      for (let n = 0; n < 60; n++) {
        await page.keyboard.press('Tab');
        if (await tabs.getByRole('tab', { name: 'Overview', exact: true }).evaluate(n => n === document.activeElement)) { reached = true; break; }
      }
      expect(reached).toBe(true);
      assertUsable(await metrics());
      for (const [key, name] of [['ArrowRight', 'Changes'], ['End', 'Notes'], ['Home', 'Overview']]) {
        await page.keyboard.press(key!);
        const selected = tabs.getByRole('tab', { name: name!, exact: true });
        expect(await selected.evaluate(n => n === document.activeElement)).toBe(true);
        expect(await selected.getAttribute('aria-selected')).toBe('true');
        expect(await selected.evaluate(n => getComputedStyle(n).outlineStyle)).not.toBe('none');
        assertUsable(await metrics());
      }
      await caseContext.close();
    }
  } finally {
    if (evidence) writeFileSync(`${evidence}/checks.json`, JSON.stringify(observations, null, 2) + '\n');
    await browser.close();
  }
}, 60000);
