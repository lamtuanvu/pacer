import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { StatusDot } from '../app/src/ds/StatusDot';
import { MetaRow } from '../app/src/ds/MetaRow';

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
const styles = () => Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css'].map(path => Bun.file(path).text()));

browserTest('status_dot_live_respects_reduced_motion', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'no-preference' });
    await page.setContent(`<style>${(await styles()).join('\n')}</style>${renderToString(<StatusDot tone="good" live label="Running" />)}`);
    const dot = page.locator('.pc-status-dot__dot');
    expect(await dot.evaluate(node => getComputedStyle(node).animationName)).toBe('pc-status-pulse');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await dot.evaluate(node => getComputedStyle(node).animationName)).toBe('none');
    expect(await page.locator('.pc-status-dot__label').textContent()).toBe('Running');
  } finally { await browser.close(); }
}, 20_000);

browserTest('status_dot_paired_glyph_label_is_visually_hidden', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${(await styles()).join('\n')}</style><p id="a">${renderToString(<StatusDot tone="warn" label="Needs you" />)}</p><p id="b">${renderToString(<StatusDot tone="warn" label="Needs you" paired="glyph" />)}</p>`);
    expect(await page.locator('#a .pc-status-dot__label').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(1);
    expect(await page.locator('#b .pc-status-dot__label').evaluate(node => node.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    expect(await page.locator('#b').ariaSnapshot()).toContain('Needs you');
  } finally { await browser.close(); }
}, 20_000);

browserTest('meta_row_no_overflow_at_272px', async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    const markup = renderToString(<MetaRow label="Task facts" items={[
      { icon: 'branch', text: 'feature/a-very-long-unbroken-branch-name-for-narrow-containment' },
      { icon: 'time', text: 'Ran for a very long time with many spaced words' },
      { icon: 'files', text: '17 files' },
    ]} />);
    await page.setContent(`<style>${(await styles()).join('\n')}</style><div style="width:272px">${markup}</div>`);
    const row = page.locator('.pc-meta-row');
    expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await row.locator('..').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const facts = await page.locator('.pc-meta-row__text').evaluateAll(nodes => nodes.map(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      return { whiteSpace: getComputedStyle(node).whiteSpace, lines: new Set(rects.map(rect => rect.top)).size };
    }));
    for (const fact of facts) {
      expect(fact.whiteSpace).toBe('nowrap');
      expect(fact.lines).toBe(1);
    }
  } finally { await browser.close(); }
}, 20_000);
