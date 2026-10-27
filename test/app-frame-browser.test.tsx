import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it these checks skip.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);

async function frame() {
  const build = await Bun.build({ entrypoints: ["test/fixtures/app-frame-browser.tsx"], target: "browser", splitting: false, plugins: [{ name: "stub-pty-view", setup(builder) {
    builder.onResolve({ filter: /term\/LazyTerminal$/ }, () => ({ path: "stub", namespace: "terminal-stub" }));
    builder.onLoad({ filter: /.*/, namespace: "terminal-stub" }, () => ({ contents: "export const LazyTerminal = () => null;", loader: "js" }));
  } }] });
  expect(build.success).toBe(true);
  const css = [generateTokensCss(readTokens("app/src/ds")), ...await Promise.all(["app/src/ds/components.css", "app/src/ds/feedback.css", "app/src/styles.css", "app/src/screens/session/session.css", "app/src/screens/terminal/terminal.css", "app/src/screens/work/work.css"].map(path => Bun.file(path).text()))].join("\n");
  return { source: await build.outputs[0]!.text(), css };
}
async function open(page: Page, built: { source: string; css: string }, hash: string) {
  // A real origin, so localStorage works as in the app.
  await page.route("http://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>frame</title><div id="app"></div>' }));
  await page.goto(`http://pacer.test/${hash}`);
  await page.evaluate(css => { document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`); }, built.css);
  await page.evaluate(async code => { const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })); await import(url); URL.revokeObjectURL(url); }, built.source);
  await page.locator("#main-content").waitFor();
}
// Preact runs effects after paint, so wait for focus to settle rather than reading it once.
const focused = (page: Page, selector: string) => page.waitForFunction(at => document.activeElement?.matches(at), selector, { timeout: 2000 });
const noHorizontalOverflow = (page: Page) => page.evaluate(() => {
  const root = document.scrollingElement!, main = document.getElementById("main-content")!;
  return root.scrollWidth <= root.clientWidth && main.scrollWidth <= main.clientWidth;
});

browserTest("dock_focus_moves_in_and_returns", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built, "#/overview");
    const button = page.getByRole("button", { name: "Terminal", exact: true });
    await expect(button.getAttribute("aria-expanded")).resolves.toBe("false");
    await button.click();
    const dock = page.getByRole("region", { name: "Terminal panel" });
    await dock.waitFor();
    await focused(page, "#pc-terminal-dock");
    await expect(button.getAttribute("aria-expanded")).resolves.toBe("true");
    await expect(button.getAttribute("aria-controls")).resolves.toBe("pc-terminal-dock");
    // Ctrl-` from inside the dock closes it and returns focus to the opener.
    await page.keyboard.press("Control+Backquote");
    await expect(dock.count()).resolves.toBe(0);
    await focused(page, '[aria-label="Terminal"]');
    // Keyboard open from the main landmark, close with the dock's own control.
    await page.locator("#main-content").focus();
    await page.keyboard.press("Control+Backquote");
    await dock.waitFor();
    await focused(page, "#pc-terminal-dock");
    // The embedded terminal keeps its tab choice local: the route stays on Overview.
    await page.getByRole("button", { name: "New terminal" }).click();
    await dock.getByRole("navigation", { name: "Terminals" }).getByRole("button", { name: "Shell", exact: true }).waitFor();
    expect(await page.evaluate(() => location.hash)).toBe("#/overview");
    await expect(dock.getByRole("button", { name: "Shell", exact: true }).getAttribute("aria-current")).resolves.toBe("true");
    await dock.focus();
    await page.getByRole("button", { name: "Hide terminal panel" }).click();
    await expect(dock.count()).resolves.toBe(0);
    await focused(page, "#main-content");
    // The terminal route has no dock and no dock control.
    await page.evaluate(() => { location.hash = "#/terminal"; });
    await button.waitFor({ state: "detached" });
    await page.keyboard.press("Control+Backquote");
    await page.waitForTimeout(100);
    expect(await dock.count()).toBe(0);
  } finally { await browser.close(); }
}, 20_000);

browserTest("settings_panel_collapse_keeps_main_usable", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const width of [1440, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await open(page, built, "#/settings");
      const panel = page.getByRole("complementary", { name: "Settings" });
      await panel.waitFor();
      expect(await noHorizontalOverflow(page)).toBe(true);
      const hide = page.getByRole("button", { name: "Hide Settings" });
      await expect(hide.getAttribute("aria-expanded")).resolves.toBe("true");
      await hide.click();
      await expect(panel.count()).resolves.toBe(0);
      expect(await noHorizontalOverflow(page)).toBe(true);
      const show = page.getByRole("button", { name: "Show Settings" });
      await expect(show.getAttribute("aria-expanded")).resolves.toBe("false");
      // Main content stays reachable and operable with the panel closed.
      await page.getByRole("textbox", { name: "Planner" }).fill("codex");
      await expect(page.getByRole("button", { name: "Save settings" }).isVisible()).resolves.toBe(true);
      const closedMain = await page.locator("#main-content").evaluate(node => node.getBoundingClientRect().width);
      await page.locator("#main-content").focus();
      await page.keyboard.press("Control+b");
      await panel.waitFor();
      expect(await page.locator("#main-content").evaluate(node => node.getBoundingClientRect().width)).toBeLessThan(closedMain);
      expect(await noHorizontalOverflow(page)).toBe(true);
      // Open state persists across a reload.
      await hide.click();
      expect(await page.evaluate(() => localStorage.getItem("pacer.panel.settings"))).toBe("0");
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);
