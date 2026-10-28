import { expect, test } from "bun:test";
import { chromium } from "playwright-core";

const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);

browserTest("tray menu floats above a fixed-height rounded panel", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 500 } });
    await page.setContent('<main class="tray"><header class="tray-planner">Planner</header><section class="tray-clear">Nothing needs you</section><div class="tray-actions"><nav class="tray-footer">Actions</nav></div></main>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    const panel = page.locator(".tray");
    const footer = page.locator(".tray-footer");
    const height = await panel.evaluate(node => node.getBoundingClientRect().height);
    const footerTop = (await footer.boundingBox())!.y;

    await page.locator(".tray-actions").evaluate(node => {
      const menu = document.createElement("nav");
      menu.className = "tray-menu";
      menu.textContent = "Switch strategy · Launch at login · Quit";
      node.append(menu);
    });

    const menu = (await page.locator(".tray-menu").boundingBox())!;
    expect(await panel.evaluate(node => node.getBoundingClientRect().height)).toBe(height);
    expect((await footer.boundingBox())!.y).toBe(footerTop);
    expect(menu.y + menu.height).toBeLessThan(footerTop);
    expect(menu.x + menu.width).toBeLessThanOrEqual(340);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect(parseFloat(await page.evaluate(() => getComputedStyle(document.body).borderTopLeftRadius))).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
}, 20000);

const plannerLine = '<main class="tray"><header class="tray-planner"><div class="tray-line"><div class="tray-identity"><span style="display:inline-block;width:18px;height:18px;flex:none"></span><strong>Claude Code Enterprise</strong><span class="tray-planner-label">planner</span></div><div class="tray-state"><span class="pc-pill pc-pill--neutral"><span class="pc-glyph pc-status--neutral" aria-hidden="true">?</span>Usage unknown</span><span class="tray-mode">emergency</span></div></div></header></main>';

for (const width of [340, 260]) browserTest(`tray planner identity never runs under the status pill at ${width}px`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 500 } });
    await page.setContent(plannerLine);
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    const identity = (await page.locator(".tray-identity").boundingBox())!;
    const state = (await page.locator(".tray-state").boundingBox())!;
    const label = page.locator(".tray-planner-label");
    const labelBox = (await label.boundingBox())!;
    const ellipsized = await label.evaluate(node => node.scrollWidth > node.clientWidth);

    // One header row: the old wrapping layout dropped the state group below the identity instead of keeping them side by side.
    expect(state.y).toBeLessThan(identity.y + identity.height);
    expect(identity.x + identity.width).toBeLessThanOrEqual(state.x);
    expect(labelBox.x + labelBox.width <= identity.x + identity.width || ellipsized).toBe(true);
    const name = page.locator(".tray-identity strong");
    const nameBox = (await name.boundingBox())!;
    const nameEllipsized = await name.evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === "ellipsis");
    expect(nameBox.x + nameBox.width <= identity.x + identity.width + 0.5 || nameEllipsized).toBe(true);
    expect(state.x).toBeGreaterThanOrEqual(0);
    expect(state.y).toBeGreaterThanOrEqual(0);
    expect(state.x + state.width).toBeLessThanOrEqual(width);
    expect(state.y + state.height).toBeLessThanOrEqual(500);
  } finally {
    await browser.close();
  }
}, 20000);
