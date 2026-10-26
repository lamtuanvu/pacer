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
