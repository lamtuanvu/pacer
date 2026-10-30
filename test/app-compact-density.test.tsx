import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { Button, ButtonLink, TextAction } from '../app/src/ds/Button';
import { TextInput, TextArea, Switch } from '../app/src/ds/Controls';
import { Tabs } from '../app/src/ds/Patterns';
import { SearchPicker } from '../app/src/ds/SearchPicker';
import { ChoicePicker } from '../app/src/ds/ChoicePicker';
import { DensityContext, DensityProvider, NarrowContext } from '../app/src/ds/Density';

const browserPath = process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('Comfortable desktop controls align with Delegate; touch and multiline controls retain room', async () => {
  const styles = (await Promise.all(['tokens.css', 'components.css'].map(file => Bun.file(`app/src/ds/${file}`).text()))).join('\n');
  const controls = <><Button size="sm">Delegate</Button><Button>Take over</Button><Button variant="danger">Stop</Button><Button size="bar">Header action</Button>
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
    expect(desktop[0]!.height).toBe(32);
    expect(await page.locator('input').evaluate(node => getComputedStyle(node).fontSize)).toBe('13px');
    for (const control of desktop) expect(control.height).toBe(desktop[0]!.height);
    expect(await page.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);
    await page.getByRole('button', {name: 'Take over'}).focus();
    expect(await page.getByRole('button', {name: 'Take over'}).evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
    await page.setViewportSize({width: 375, height: 900});
    await page.setContent(`<style>${styles}</style>${renderToString(<NarrowContext.Provider value={true}>{controls}</NarrowContext.Provider>)}`);
    for (const control of await geometry()) expect(control.height).toBeGreaterThanOrEqual(44);
    expect(await page.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);
    await page.setContent(`<style>${styles}</style>${renderToString(controls)}`);
    for (const control of await geometry()) expect(control.height).toBeGreaterThanOrEqual(44);
    expect(await page.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);
    await page.setViewportSize({width: 1440, height: 900});
    await page.setContent(`<style>${styles}</style>${renderToString(<DensityProvider value="compact">{controls}</DensityProvider>)}`);
    for (const control of await geometry()) expect(control.height).toBe(28);
    await page.setViewportSize({width: 1440, height: 900});
    await page.setContent(`<style>${styles}</style>${renderToString(<DensityProvider value="settings">{controls}</DensityProvider>)}`);
    for (const control of await geometry()) expect(control.height).toBe(32);
    expect(await page.locator('input').evaluate(node => node.getBoundingClientRect().height)).toBe(32);
    expect(await page.locator('textarea').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(96);
    await page.setContent(`<style>${styles}</style>${renderToString(<DensityProvider value="compact"><DensityContext.Provider value="settings"><Button>Card action</Button></DensityContext.Provider></DensityProvider>)}`);
    expect((await geometry())[0]!.height).toBe(28);
    const trayStyles = await Bun.file('app/src/tray/tray.css').text();
    await page.setContent(`<style>${styles}${trayStyles}</style>${renderToString(<DensityProvider value="compact"><div className="tray"><Button>Tray action</Button></div></DensityProvider>)}`);
    expect((await geometry())[0]!.height).toBe(32);
    await page.setViewportSize({width: 375, height: 900});
    expect((await geometry())[0]!.height).toBe(32);
    await page.setContent(`<style>${styles}</style>${renderToString(<NarrowContext.Provider value={true}><DensityProvider value="compact">{controls}</DensityProvider></NarrowContext.Provider>)}`);
    for (const control of await geometry()) expect(control.height).toBeGreaterThanOrEqual(44);
    const touchPage = await browser.newPage({ viewport: {width: 1440, height: 900}, hasTouch: true });
    await touchPage.setContent(`<style>${styles}</style>${renderToString(<DensityProvider value="compact">{controls}</DensityProvider>)}`);
    for (const height of await touchPage.locator('button,a,input').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
    await touchPage.close();
  } finally { await browser.close(); }
});

// Include consumer CSS in build order: page selectors must not shrink shared touch targets.
test.skipIf(!browserPath)('shared controls, repo chips and Tasks tabs keep 44px touch targets', async () => {
  const files = ['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/styles.css', 'app/src/screens/session/session.css'];
  const styles = (await Promise.all(files.map(file => Bun.file(file).text()))).join('\n');
  const controls = <><Switch size="sm" aria-label="Enable plugin" /><TextAction href="#help">Help</TextAction><a href="#notes" className="pc-inline-link">Notes</a><button className="pc-aurora-launcher">Ask pacer</button><div className="pc-task-card__row"><a href="#task" className="pc-task-card__title">Task</a></div><a href="#changes" className="pc-task-card__action">Changes</a><button className="pc-task-card__toggle">Subtasks</button><div className="pc-tasks-page__search"><TextInput aria-label="Search tasks" /></div><div className="pc-filter--menu"><SearchPicker label="Repository" searchLabel="Find repo" placeholder="Search" emptyLabel="No repos" value={null} options={[{ value: null, label: 'All repos' }]} onChange={() => {}} /></div>
    <div className="pc-tasks-page"><Tabs label="Tasks" id="tasks" value="all" options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'Running' }]} onChange={() => {}} /></div></>;
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const hasTouch of [false, true]) {
      const page = await browser.newPage({ viewport: { width: hasTouch ? 1440 : 390, height: 900 }, hasTouch });
      for (const density of ['normal', 'compact'] as const) {
        for (const narrow of [false, true]) {
          await page.setContent(`<style>${styles}</style>${renderToString(<NarrowContext.Provider value={narrow}><DensityProvider value={density}>{controls}</DensityProvider></NarrowContext.Provider>)}`);
          for (const rect of await page.locator('button,a,input').evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width })))) {
            expect(rect.height).toBeGreaterThanOrEqual(44);
            expect(rect.width).toBeGreaterThanOrEqual(44);
          }
        }
      }
      await page.close();
    }
  } finally { await browser.close(); }
});
