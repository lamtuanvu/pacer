import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
async function open(fn: (page: import('playwright-core').Page) => Promise<void>) {
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/add-host.tsx'], target: 'browser', minify: true });
  expect(built.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: await built.outputs[0]!.text() });
    await fn(page);
  } finally { await browser.close(); }
}
const calls = (page: import('playwright-core').Page) => page.evaluate(() => (window as any).hostFixture.calls() as [string, any][]);

browserTest('Add remote host: pick an alias, name it, then watch a live connect-and-check', async () => {
  await open(async page => {
    const connect = page.getByRole('button', { name: 'Connect and check', exact: true });
    expect(await connect.isDisabled()).toBe(true);
    expect(await page.getByText('Pick a host from your SSH config first.').count()).toBe(1);
    await page.getByRole('button', { name: 'devbox', exact: true }).click();
    // The name is suggested from the alias and can be edited; a taken name blocks the check with a reason.
    const name = page.getByRole('textbox', { name: /Name it in pacer/ });
    expect(await name.inputValue()).toBe('devbox');
    await name.fill('taken');
    expect(await connect.isDisabled()).toBe(true);
    await page.getByText('Another host already has this name.').waitFor();
    await name.fill('Bad Name');
    expect(await connect.isDisabled()).toBe(true);
    await name.fill('dev-1');
    await connect.click();
    await page.getByRole('status').filter({ hasText: 'dev-1 is connected' }).waitFor();
    expect((await calls(page)).map(([op]) => op).filter(op => op === 'host.add' || op === 'host.check')).toEqual(['host.add', 'host.check']);
    expect((await calls(page)).find(([op]) => op === 'host.add')![1]).toEqual({ alias: 'dev-1', ssh: 'devbox' });
    const list = page.getByRole('list', { name: 'Checks for dev-1' });
    expect(await list.getByRole('listitem').allTextContents()).toEqual(['✓Passed: Connects with your SSH key, no password prompt', '✓Passed: git 2.30 or newer2.47.0']);
    expect(await page.getByRole('link', { name: 'Map repositories' }).getAttribute('href')).toBe('#/settings/hosts/dev-1');
    expect(await connect.count()).toBe(0);
  });
}, 20000);

browserTest('a failed check names the reason and checks again without adding the host twice', async () => {
  await open(async page => {
    await page.evaluate(() => (window as any).hostFixture.failFirst(true));
    await page.getByRole('button', { name: 'pi-lab', exact: true }).click();
    await page.getByRole('button', { name: 'Connect and check', exact: true }).click();
    await page.getByRole('button', { name: 'Check again', exact: true }).waitFor();
    expect(await page.getByRole('list', { name: 'Checks for pi-lab' }).textContent()).toContain('Failed: Connects with your SSH key');
    expect(await page.getByRole('link', { name: 'Map repositories' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'pi-lab is connected' }).waitFor();
    expect((await calls(page)).filter(([op]) => op === 'host.add')).toHaveLength(1);
  });
}, 20000);

browserTest('Stepper moves focus with the arrow keys, Home and End, and selects with Enter', async () => {
  await open(async page => {
    const buttons = page.getByRole('list', { name: 'Wizard' }).getByRole('button');
    expect(await buttons.count()).toBe(3);
    await buttons.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    expect(await buttons.nth(1).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('End');
    expect(await buttons.nth(2).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(await buttons.nth(2).evaluate(n => n === document.activeElement)).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.locator('#picked').textContent()).toBe('2');
    expect(await page.locator('[aria-current="step"]').count()).toBe(1);
    expect(await page.getByText('D', { exact: true }).evaluate(n => n.closest('button'))).toBeNull();
  });
}, 20000);

async function openAgent(fn: (page: import('playwright-core').Page) => Promise<void>) {
  const built = await Bun.build({ entrypoints: ['test/fixtures/ui/add-agent.tsx'], target: 'browser', minify: true });
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { try { sessionStorage.clear(); } catch { /* none */ } });
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: await built.outputs[0]!.text() });
    await fn(page);
  } finally { await browser.close(); }
}
const agentCalls = (page: import('playwright-core').Page) => page.evaluate(() => (window as any).agentFixture.calls() as [string, any][]);
const toStepFour = async (page: import('playwright-core').Page) => {
  await page.getByRole('button', { name: /Codex/ }).first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('.pc-choice-card').filter({ hasText: 'team' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
};

browserTest('Add agent: creates once with the chosen options, then is Ready only after the test task passes', async () => {
  await openAgent(async page => {
    await toStepFour(page);
    // The host link prefill reached step 3 (local was kept here), and the step heading took focus on arrival.
    await page.waitForFunction(() => document.activeElement?.textContent === 'Model, then a test task');
    await page.getByRole('button', { name: 'Tests', exact: true }).click();
    const add = page.getByRole('button', { name: 'Add agent and run test task' });
    await add.dblclick();
    await page.getByText('codex#team is ready.').waitFor();
    const adds = (await agentCalls(page)).filter(([op]) => op === 'runner.add');
    expect(adds).toHaveLength(1);
    expect(adds[0]![1]).toEqual({ agent: 'codex', account: 'team', host: 'devbox', kinds: ['tests'], max_tasks: 1, test: true });
    expect(await page.getByRole('link', { name: 'Open agents' }).getAttribute('href')).toBe('#/settings/executors');
    expect(await page.getByRole('button', { name: 'Add agent and run test task' }).count()).toBe(0);
  });
});

browserTest('Add agent: a failed test never shows Ready, can re-run, and the added agent can be removed', async () => {
  await openAgent(async page => {
    await page.evaluate(() => (window as any).agentFixture.outcome('failed'));
    await toStepFour(page);
    await page.getByRole('button', { name: 'Add agent and run test task' }).click();
    await page.getByRole('button', { name: 'Run test task again' }).waitFor();
    expect(await page.getByText(/is ready\./).count()).toBe(0);
    expect(await page.getByText('Not logged in').count()).toBeGreaterThan(0);
    expect(await page.getByRole('button', { name: 'Remove this agent' }).count()).toBe(1);
    await page.evaluate(() => (window as any).agentFixture.outcome('passed'));
    await page.getByRole('button', { name: 'Run test task again' }).click();
    await page.getByText('codex#team is ready.').waitFor();
    expect((await agentCalls(page)).filter(([op]) => op === 'runner.add')).toHaveLength(1);
    expect((await agentCalls(page)).filter(([op]) => op === 'runner.check')).toHaveLength(1);
  });
});

browserTest('Add agent: Remove this agent asks first, removes the executor and returns to step 1', async () => {
  await openAgent(async page => {
    await page.evaluate(() => (window as any).agentFixture.outcome('failed'));
    await toStepFour(page);
    await page.getByRole('button', { name: 'Add agent and run test task' }).click();
    await page.getByRole('button', { name: 'Remove this agent' }).waitFor();
    await page.getByRole('button', { name: 'Remove this agent' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('heading', { name: 'Which agent?' }).waitFor();
    expect((await agentCalls(page)).find(([op]) => op === 'runner.remove')![1]).toEqual({ id: 'codex#team' });
  });
});

browserTest('Add host: a check that cannot start is reported, not silently retried', async () => {
  await open(async page => {
    await page.getByRole('button', { name: 'devbox', exact: true }).click();
    await page.evaluate(() => (window as any).hostFixture.failFirst(true));
    await page.getByRole('button', { name: 'Connect and check', exact: true }).click();
    await page.getByRole('list', { name: 'Checks for devbox' }).waitFor();
    expect(await page.getByRole('status').filter({ hasText: 'Changes saved' }).count()).toBe(0);
  });
});
