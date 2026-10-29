import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { Page, PageBody, PageHeader, Section, Stack, DisclosurePanel } from '../app/src/ds/Page';
import { TaskResultView } from '../app/src/screens/TaskResult';
import { Prose } from '../app/src/ds/Prose';
import type { TaskDetail } from '../src/core/task-detail';
import fixture from './fixtures/ui/task-get.json';

const browserPath = process.env.PACER_TEST_BROWSER;

test.skipIf(!browserPath)('layout gaps own spacing without added text/header margins; related disclosures stay together', async () => {
  // Match production cascade order, including dynamically installed settings styles.
  const files = [
    'app/src/ds/tokens.css',
    'app/src/ds/components.css',
    'app/src/styles.css',
    'app/src/screens/session/session.css',
    'app/src/screens/settings/settings.css',
  ];
  const css = (await Promise.all(files.map(file => Bun.file(file).text()))).join('\n');
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      const composition = <Page width="standard"><PageBody>
        <PageHeader>Header</PageHeader>
        <Stack><p>First</p><p>Second</p></Stack>
        <Section title="Section"><p>Body</p><p>More</p></Section>
        <DisclosurePanel summary="Details" open>
          <p className="report">Detail</p>
          <pre className="acceptance-output">Output</pre>
        </DisclosurePanel>
        <Prose text={'One\n\nTwo'} />
      </PageBody></Page>;
      await page.setContent(`<style>${css}</style>${renderToString(composition)}`);
      const layout = await page.locator('.pc-page-body').evaluate(node => {
        const children = Array.from(node.children);
        return {
          gap: parseFloat(getComputedStyle(node).rowGap),
          actual: children[1]!.getBoundingClientRect().top - children[0]!.getBoundingClientRect().bottom,
        };
      });
      expect(layout.actual).toBe(layout.gap);
      const margins = await page.locator([
        '.pc-stack > p',
        '.pc-composed-section__body > p',
        '.pc-disclosure-panel__body > p',
        '.pc-disclosure-panel__body > pre',
      ].join(',')).evaluateAll(nodes => nodes.map(node => [
        getComputedStyle(node).marginTop,
        getComputedStyle(node).marginBottom,
      ]));
      for (const margin of margins) expect(margin).toEqual(['0px', '0px']);
      const proseGap = await page.locator('.pc-prose').evaluate(node =>
        node.children[1]!.getBoundingClientRect().top - node.children[0]!.getBoundingClientRect().bottom);
      expect(proseGap).toBe(12);

      await page.setContent(`<style>${css}</style>
        <div class="u3-settings u3-general-sections"><section class="u3-section">
          <div class="u3-setting">
            <div><p>First label</p><p>Description</p></div><div>Control</div>
          </div>
          <div class="u3-setting"><div><p>Second label</p></div><div>Control</div></div>
        </section></div>`);
      const rowGap = await page.locator('.u3-setting').evaluateAll(nodes =>
        nodes[1]!.querySelector('p')!.getBoundingClientRect().top - nodes[0]!.getBoundingClientRect().bottom);
      expect(rowGap).toBe(12);

      await page.setContent(`<style>${css}</style>
        <div class="pc-detail-navigation"><header class="pc-page-header">Identity</header><div>Tabs</div></div>
        <section class="u3-section">
          <div class="u3-save-bar">Save</div>
          <div class="pc-card pc-project-strategies">
            <div class="u3-choices">Choices</div><footer class="u3-footer">Actions</footer>
          </div>
        </section>`);
      const retainedMargins = await page.locator([
        '.pc-detail-navigation > .pc-page-header',
        '.u3-section > .u3-save-bar',
        '.u3-section > .pc-project-strategies',
        '.pc-card > .u3-choices',
        '.pc-card > .u3-footer',
      ].join(',')).evaluateAll(nodes => nodes.map(node => [
        getComputedStyle(node).marginTop, getComputedStyle(node).marginBottom,
      ]));
      for (const margin of retainedMargins) expect(margin).toEqual(['0px', '0px']);

      await page.setContent(`<style>${css}</style><div class="u3-settings"><div class="pc-project-editor">
        <p>Using global strategy</p><ol class="pc-project-order"></ol><p>Order help</p>
      </div></div>`);
      const emptyOrderGap = await page.locator('.pc-project-editor p').evaluateAll(nodes =>
        nodes[1]!.getBoundingClientRect().top - nodes[0]!.getBoundingClientRect().bottom);
      expect(emptyOrderGap).toBe(12);

      const task = {
        ...fixture,
        acceptance: { ...fixture.acceptance, tail: 'Checks passed' },
      } as unknown as TaskDetail;
      await page.setContent(`<style>${css}</style>${renderToString(<TaskResultView task={task} />)}`);
      const gaps = await page.locator('.pc-page-columns__main .pc-disclosure-panel').evaluateAll(nodes =>
        nodes.slice(1).map((node, i) => node.getBoundingClientRect().top - nodes[i]!.getBoundingClientRect().bottom));
      expect(gaps).toHaveLength(4);
      for (const gap of gaps) expect(gap).toBe(8);
      const height = await page.getByText('Executor transcript', { exact: true }).evaluate(node =>
        node.getBoundingClientRect().height);
      expect(height).toBe(width === 375 ? 44 : 36);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    await browser.close();
  }
});
