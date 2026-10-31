import { beforeAll, expect, test } from 'bun:test';
import { chromium } from 'playwright-core';

const browserPath = process.env.PACER_TEST_BROWSER;
let fixtureScript = '', styles = '';
beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/planner-preview-keyboard.tsx'], target: 'browser' });
  if (!built.success) throw new AggregateError(built.logs);
  fixtureScript = await built.outputs[0]!.text();
  styles = (await Promise.all(['tokens.css', 'components.css'].map(file => Bun.file(`app/src/ds/${file}`).text()))).join('\n');
}, 15000);
for (const width of [1440, 375]) for (const colorScheme of ['light', 'dark'] as const) {
  test.skipIf(!browserPath)(`planner preview retains complete text and supports keyboard scrolling at ${width} ${colorScheme}`, async () => {
    const preview = {
      files: [`$HOME/${'project-directory/'.repeat(24)}skills/pacer/SKILL.md`],
      detail: `Settings: ${'preserve user configuration; '.repeat(30)}`,
      undo: `pacer uninstall codex#${'named-account-'.repeat(30)}work`,
    };
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' });
      await page.setContent(`<meta name="viewport" content="width=device-width"><style>${styles}</style><div id="root"></div>`);
      await page.evaluate(value => { (window as typeof window & { pacerPreviewFixture: typeof value }).pacerPreviewFixture = value; }, preview);
      await page.addScriptTag({ content: fixtureScript, type: 'module' });
      await page.locator('summary').waitFor();
      await page.locator('summary').focus();
      await page.keyboard.press('Enter');
      const regions = page.locator('pre');
      expect(await regions.count()).toBe(3);
      for (const [index, text] of [preview.files.join('\n'), preview.detail, preview.undo].entries()) {
        await page.keyboard.press('Tab');
        const region = regions.nth(index);
        expect(await region.evaluate(node => document.activeElement === node)).toBe(true);
        expect(await region.textContent()).toBe(text);
        expect(await region.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
        expect(await region.evaluate(node => Number.parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThan(0);
        // The hydrated setup component must perform the actual keyboard scroll.
        await region.evaluate(node => node.addEventListener('keydown', event => {
          (node as HTMLElement).dataset.arrowPrevented = String(event.defaultPrevented);
        }, { once: true }));
        await region.press('ArrowRight');
        expect(await region.getAttribute('data-arrow-prevented')).toBe('true');
        const right = await region.evaluate(node => node.scrollLeft);
        expect(right).toBeGreaterThan(0);
        await region.press('ArrowLeft');
        expect(await region.evaluate(node => node.scrollLeft)).toBeLessThan(right);
      }
      await page.keyboard.press('Tab');
      expect(await page.getByRole('button', { name: 'Continue' }).evaluate(node => document.activeElement === node)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await browser.close(); }
  });
}

test.skipIf(!browserPath)('narrow setup keeps a Tab-focused preview above the fixed navigation', async () => {
  const appStyles = await Bun.file('app/src/styles.css').text();
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 900 }, colorScheme: 'dark' });
    await page.setContent(`<meta name="viewport" content="width=device-width"><style>${styles}\n${appStyles}</style>
      <div class="pc-app pc-app--narrow"><main class="pc-setup">
        <div style="height:900px"></div><details open><summary>Show the files</summary>
        <pre class="pc-code-scroll" tabindex="0">${'long-path/'.repeat(60)}</pre></details>
        <div style="height:900px"></div>
      </main><nav class="pc-bottom-bar" aria-label="Navigation"></nav></div>`);
    await page.evaluate(() => {
      const preview = document.querySelector('pre')!;
      window.scrollTo(0, preview.getBoundingClientRect().bottom + window.scrollY - window.innerHeight);
    });
    await page.locator('summary').evaluate(node => (node as HTMLElement).focus({ preventScroll: true }));
    await page.keyboard.press('Tab');
    const position = await page.locator('pre').evaluate(node => ({
      focused: document.activeElement === node,
      bottom: node.getBoundingClientRect().bottom,
      navigationTop: document.querySelector('.pc-bottom-bar')!.getBoundingClientRect().top,
    }));
    expect(position.focused).toBe(true);
    expect(position.bottom).toBeLessThan(position.navigationTop);
  } finally { await browser.close(); }
});
