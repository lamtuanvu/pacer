import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { renderToString } from "preact-render-to-string";
import { AppFrame } from "../app/src/shell/AppFrame";
import { Button } from "../app/src/ds/Button";

const panelCss = await Bun.file("app/src/shell/panels/work-panels.css").text();
const shellCss = await Bun.file("app/src/styles.css").text();

test("always-loaded shell styles give every direct right frame slot a scrollport", () => {
  const selector = /\.pc-side-panel--right\s*>\s*\.pc-frame-slot\s*\{([^}]+)\}/;
  const rule = shellCss.match(selector)?.[1];
  expect(rule).toBeDefined();
  expect(panelCss).not.toMatch(selector);
  expect(rule).toMatch(/display:\s*flex/);
  expect(rule).toMatch(/flex-direction:\s*column/);
  expect(rule).toMatch(/height:\s*100%/);
  expect(rule).toMatch(/overflow:\s*auto/);
  expect(rule).toMatch(/min-height:\s*0/);
  expect(rule).toMatch(/overscroll-behavior-y:\s*contain/);
});

test.skipIf(!process.env.PACER_TEST_BROWSER)("shell panel scrolls tall content without moving the page", async () => {
  const css = (await Promise.all([
    "app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/styles.css",
    "app/src/screens/settings/settings.css", "app/src/screens/trace/trace.css",
  ].map(path => Bun.file(path).text()))).join("\n");
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    for (const height of [400, 900]) {
      for (const contentClass of ["u3-agent-detail", "pc-trace__aside", "pc-work-panel-body", "pc-setup-rail"]) {
        const page = await browser.newPage({ viewport: { width: 1440, height } });
        const setup = contentClass === "pc-setup-rail";
        // Settings and Trace can open before WorkPanels ever mounts.
        const workStyles = setup || contentClass === "pc-work-panel-body" ? panelCss : "";
        const panel = <aside className={`pc-side-panel ${setup ? "pc-side-panel--left pc-scope-panel" : "pc-side-panel--right"}`}>
          <div className="pc-frame-slot"><div className="pc-view-slot"><section className={contentClass}>
            {Array.from({ length: 60 }, (_, i) => <p key={i}>Panel row {i}</p>)}
            <Button>Save model</Button>
          </section></div></div>
        </aside>;
        await page.setContent(`<style>${css}${workStyles}</style>${renderToString(<AppFrame
          top={<header className="pc-topbar">Header</header>}
          main={Array.from({ length: 100 }, (_, i) => <p key={i}>Page row {i}</p>)}
          left={setup ? panel : undefined} right={setup ? undefined : panel}
        />)}`);
        const slot = page.locator(".pc-frame-slot");
        expect(await slot.evaluate(el => getComputedStyle(el).overflowY)).toBe("auto");
        const box = (await slot.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 300);
        await page.waitForFunction(() => document.querySelector(".pc-frame-slot")!.scrollTop > 0);
        await slot.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await page.mouse.wheel(0, 300);
        const save = (await page.getByRole("button", { name: "Save model" }).boundingBox())!;
        expect(save.y).toBeGreaterThanOrEqual(box.y);
        expect(save.y + save.height).toBeLessThanOrEqual(box.y + box.height + 1);
        expect(await page.locator(".pc-main-scroll").evaluate(el => el.scrollTop)).toBe(0);
        expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});
