import { expect, test } from "bun:test";
import { chromium } from "playwright-core";

const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);

browserTest("desktop canvas clips to rounded transparent corners while web stays square", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
    await page.setContent('<div id="app"><div class="pc-app"><header class="pc-titlebar">Title</header><div class="pc-body"><div class="pc-work">Content</div></div></div></div>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/styles.css"].map(path => Bun.file(path).text()))).join("\n") });
    const metrics = () => page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const canvas = getComputedStyle(document.querySelector("#app")!);
      const content = getComputedStyle(document.querySelector(".pc-work")!);
      return { bodyBackground: body.backgroundColor, canvasRadius: canvas.borderTopLeftRadius, canvasOverflow: canvas.overflowY, contentOverflow: content.overflowY };
    });
    expect((await metrics()).bodyBackground).toBe("rgb(255, 255, 255)");
    await page.evaluate(() => document.documentElement.dataset.pacerDesktop = "");
    const desktop = await metrics();
    expect(desktop.bodyBackground).toBe("rgba(0, 0, 0, 0)");
    expect(parseFloat(desktop.canvasRadius)).toBeGreaterThan(0);
    expect(desktop.canvasOverflow).toBe("hidden");
    expect(desktop.contentOverflow).toBe("auto");
  } finally {
    await browser.close();
  }
}, 20000);

browserTest("bundled desktop startup screen also clips its canvas", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
    await page.setContent('<main>Starting pacer</main>');
    await page.addStyleTag({ content: await Bun.file("desktop/ui/shell.css").text() });
    const body = await page.locator("body").evaluate(node => {
      const style = getComputedStyle(node);
      return { height: node.getBoundingClientRect().height, radius: style.borderTopLeftRadius, overflow: style.overflowY };
    });
    expect(body.height).toBe(760);
    expect(parseFloat(body.radius)).toBeGreaterThan(0);
    expect(body.overflow).toBe("auto");
  } finally {
    await browser.close();
  }
}, 20000);

browserTest("desktop route reset and Tasks scroll positions use the clipped canvas", async () => {
  const built = await Bun.build({ entrypoints: ["test/fixtures/ui/page-scroll.ts"], target: "browser" });
  expect(built.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
    await page.setContent('<div id="app"><div class="pc-app"><header class="pc-titlebar">Title</header><div class="pc-body"><div class="pc-work"><div style="height: 1800px; flex: none">Content</div></div></div></div></div>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/styles.css"].map(path => Bun.file(path).text()))).join("\n") });
    await page.addScriptTag({ content: await built.outputs[0]!.text() });
    await page.evaluate(() => {
      const fixture = (window as typeof window & { pageScrollFixture: typeof import("../app/src/shell/page-scroll") }).pageScrollFixture;
      (window as typeof window & { lateScrollEvents?: number }).lateScrollEvents = 0;
      fixture.onPageScroll(() => (window as typeof window & { lateScrollEvents: number }).lateScrollEvents++);
      document.documentElement.dataset.pacerDesktop = "";
    });
    const desktop = await page.evaluate(() => {
      const fixture = (window as typeof window & { pageScrollFixture: typeof import("../app/src/shell/page-scroll") }).pageScrollFixture;
      let events = 0;
      const stop = fixture.onPageScroll(() => events++);
      fixture.scrollPageTo(400);
      const position = fixture.pageScrollY();
      const titleTop = document.querySelector(".pc-titlebar")!.getBoundingClientRect().top;
      fixture.resetDesktopPageScroll();
      stop();
      return { position, afterReset: fixture.pageScrollY(), windowScroll: window.scrollY, titleTop, events };
    });
    expect(desktop.position).toBe(400);
    expect(desktop.afterReset).toBe(0);
    expect(desktop.windowScroll).toBe(0);
    expect(desktop.titleTop).toBe(0);
    await page.waitForFunction(() => (window as typeof window & { lateScrollEvents: number }).lateScrollEvents > 0);
    await page.evaluate(() => document.documentElement.removeAttribute("data-pacer-desktop"));
    const web = await page.evaluate(() => {
      const fixture = (window as typeof window & { pageScrollFixture: typeof import("../app/src/shell/page-scroll") }).pageScrollFixture;
      fixture.scrollPageTo(300);
      return { position: fixture.pageScrollY(), windowScroll: window.scrollY };
    });
    expect(web.position).toBe(300);
    expect(web.windowScroll).toBe(300);
  } finally {
    await browser.close();
  }
}, 20000);
