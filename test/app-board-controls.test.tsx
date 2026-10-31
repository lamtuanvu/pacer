import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { NarrowContext } from '../app/src/ds/Density';
import { Button, IconButton } from '../app/src/ds/Button';
import { SegmentedControl } from '../app/src/ds/Patterns';
import { SearchPicker } from '../app/src/ds/SearchPicker';
import { TaskCard } from '../app/src/ds/TaskCard';
import { TaskNavigator } from '../app/src/screens/session/TaskNavigator';
import type { TaskNodeView } from '../src/view-model/task-tree';

const browserPath = process.env.PACER_TEST_BROWSER;
const leaf = (id: string): TaskNodeView => ({ id, title: `Task ${id}`, state: { tone: 'info', label: 'Working', live: true }, active: true, attention: 'none', bucket: 'running', agents: [], children: [], meta: [] });
const root = { ...leaf('root'), children: [leaf('current'), leaf('other')] };

test.skipIf(!browserPath)('device density preserves board segments, chip geometry, row selection and popover padding', async () => {
  const styles = (await Promise.all(['app/src/ds/tokens.css', 'app/src/ds/components.css', 'app/src/styles.css', 'app/src/screens/session/session.css'].map(file => Bun.file(file).text()))).join('\n');
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    for (const density of ['normal', 'compact']) {
      const markup = renderToString(<><Button>Delegate</Button><IconButton aria-label="Control icon" icon="plus" />
        <SegmentedControl label="Period" value="week" options={[{ value: 'week', label: '7 days' }]} onChange={() => {}} />
        <SearchPicker label="All repos · 2" searchLabel="Repositories" placeholder="Search" emptyLabel="No repos" value={null} options={[]} onChange={() => {}} />
        <footer className="pc-statusbar"><Button className="pc-statusbar__usage-button">Usage</Button><div className="pc-usage-popover"><Button>Refresh usage</Button><Button>Manage accounts</Button></div></footer>
        <div className="pc-tasks-page"><TaskCard node={root} expanded onToggle={() => {}} href={id => `#${id}`} selectedId="current" /></div>
        <TaskNavigator selectedId="current" nodes={[root]} />
      </>);
      await page.setContent(`<style>${styles}</style>${markup}`);
      await page.evaluate(value => { document.documentElement.dataset.density = value; }, density);
      const height = (selector: string) => page.locator(selector).first().evaluate(node => node.getBoundingClientRect().height);
      expect(await height('button')).toBe(density === 'normal' ? 32 : 28);
      expect(await height('.pc-icon-button')).toBe(density === 'normal' ? 32 : 28);
      expect(await height('.pc-segmented button')).toBe(density === 'normal' ? 30 : 26);
      expect(await height('.pc-segmented')).toBe(density === 'normal' ? 38 : 34);
      expect(await page.locator('.pc-segmented').evaluate(node => getComputedStyle(node).padding)).toBe('3px');
      expect(await page.locator('.pc-chip--repo svg').count()).toBe(0);
      expect(await page.locator('.pc-chip--repo').evaluate(node => getComputedStyle(node).fontWeight)).toBe('600');
      expect(await page.locator('.pc-usage-popover button').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).paddingInline))).toEqual(['12px', '12px']);
      const toggles = await page.locator('.pc-task-card__toggle').evaluateAll(nodes => nodes.map(node => {
        const s = getComputedStyle(node); const icons = node.querySelectorAll('svg');
        return { height: node.getBoundingClientRect().height, padding: s.padding, border: s.borderTopWidth, radius: s.borderRadius, font: s.fontSize, weight: s.fontWeight, icons: [...icons].map(icon => icon.getBoundingClientRect().width), rotation: getComputedStyle(node.querySelector('.pc-task-card__chevron')!).transform, inset: getComputedStyle(node.parentElement!).padding };
      }));
      for (const toggle of toggles) expect(toggle).toEqual({ height: 22, padding: '0px 7px', border: '1px', radius: '6px', font: '12px', weight: '600', icons: [13, 11], rotation: 'matrix(-1, 0, 0, -1, 0, 0)', inset: '0px 8px 4px 24px' });
      expect(toggles).toHaveLength(2);
      for (const selector of ['.pc-task-card__child-title', '.pc-session-node__children strong']) {
        expect(await page.locator(selector).evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fontWeight))).toEqual(['650', '500']);
      }
      for (const selector of ['.pc-task-card__child--selected', '.pc-session-node[aria-current=page]']) {
        expect(await page.locator(selector).evaluate(node => {
          const sample = document.createElement('span'); sample.style.background = 'var(--surface-page)'; node.append(sample);
          const equal = getComputedStyle(sample).backgroundColor === getComputedStyle(node).backgroundColor; sample.remove(); return equal;
        })).toBe(true);
      }
      expect(await page.locator('.pc-task-card').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      expect(await page.locator('.pc-session-node-group').first().evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    }
    const touchChip = <NarrowContext.Provider value={true}><SearchPicker label="All repos · 2" searchLabel="Repositories" placeholder="Search" emptyLabel="No repos" value={null} options={[]} onChange={() => {}} /></NarrowContext.Provider>;
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(`<style>${styles}</style>${renderToString(touchChip)}`);
      expect(await page.locator('.pc-chip--repo').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    }
  } finally { await browser.close(); }
});
