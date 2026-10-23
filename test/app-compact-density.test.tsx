import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { Button, ButtonLink } from '../app/src/ds/Button';
import { TextInput, TextArea } from '../app/src/ds/Controls';
import { ChoicePicker } from '../app/src/ds/ChoicePicker';
import { DensityProvider, NarrowContext } from '../app/src/ds/Density';

const browserPath = process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('default desktop controls align with Delegate; touch and multiline controls retain room', async () => {
  const styles = (await Promise.all(['tokens.css', 'components.css'].map(file => Bun.file(`app/src/ds/${file}`).text()))).join('\n');
  const controls = <><Button size="sm">Delegate</Button><Button>Take over</Button><Button variant="danger">Stop</Button>
    <ButtonLink href="#retry">Retry</ButtonLink><TextInput aria-label="Branch" value="main" />
    <ChoicePicker aria-label="Executor" value="codex" options={[{ value: 'codex', label: 'Codex' }]} onValueChange={() => {}} /><TextArea aria-label="Goal" /></>;
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    await page.setContent(`<style>${styles}</style>${renderToString(controls)}`);
    const geometry = () => page.locator('button,a,input').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node);
      return { height: node.getBoundingClientRect().height, font: style.fontSize, radius: style.borderRadius };
    }));
    const desktop = await geometry();
    expect(desktop[0]!.height).toBe(28);
    for (const control of desktop) expect(control).toEqual(desktop[0]!);
    expect(await page.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);
    await page.getByRole('button', {name: 'Take over'}).focus();
    expect(await page.getByRole('button', {name: 'Take over'}).evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
    await page.setViewportSize({width: 375, height: 900});
    await page.setContent(`<style>${styles}</style>${renderToString(<NarrowContext.Provider value={true}>{controls}</NarrowContext.Provider>)}`);
    for (const control of await geometry()) expect(control.height).toBeGreaterThanOrEqual(48);
    expect(await page.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);
    await page.setContent(`<style>${styles}</style>${renderToString(controls)}`);
    for (const control of await geometry()) expect(control.height).toBeGreaterThanOrEqual(48);
    expect(await page.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);
    await page.setContent(`<style>${styles}</style>${renderToString(<DensityProvider value="compact">{controls}</DensityProvider>)}`);
    for (const control of await geometry()) expect(control.height).toBe(28);
    await page.setViewportSize({width: 1440, height: 900});
    await page.setContent(`<style>${styles}</style>${renderToString(<DensityProvider value="settings">{controls}</DensityProvider>)}`);
    expect(await page.locator('input').evaluate(node => node.getBoundingClientRect().height)).toBe(32);
    expect(await page.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);
  } finally { await browser.close(); }
});
