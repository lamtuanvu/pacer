import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it these checks skip.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);

async function frame() {
  const build = await Bun.build({ entrypoints: ["test/fixtures/app-frame-browser.tsx"], target: "browser", splitting: false, plugins: [{ name: "stub-pty-view", setup(builder) {
    builder.onResolve({ filter: /term\/LazyTerminal$/ }, () => ({ path: "stub", namespace: "terminal-stub" }));
    builder.onLoad({ filter: /.*/, namespace: "terminal-stub" }, () => ({ resolveDir: process.cwd(), loader: "js", contents: `import { h } from "preact";
    // Same structure and classes as the real terminal view, without xterm.
    export const LazyTerminal = () => h("section", { class: "pc-terminal-view" },
      h("div", { class: "pc-terminal-search", role: "search" }, h("div", { class: "pc-field field" }, h("label", null, "Search terminal output"), h("input")), h("button", null, "Previous"), h("button", null, "Next")),
      h("div", { class: "pc-terminal-frame" }, h("div", { class: "pc-terminal-pane" }), h("div", { class: "pc-terminal-strip" }, h("strong", null, "You have control"), h("span", null, "Keystrokes go to your shell."), h("span", null, "80x24"))),
      h("div", { class: "pc-session-row" }, h("button", null, "Release control"), h("span", { class: "pc-session-muted" }, "Only one window can type into this shell at a time.")));` }));
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
    // Closing with the status-bar button keeps focus on that button, even when the dock opened without an opener.
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.press("Control+Backquote");
    await dock.waitFor();
    await button.click();
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
    // The shell gets most of the 320px dock: toolbar, tabs and actions share a few compact rows.
    const sizes = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height;
      return { body: box(".pc-dock__body"), panes: box(".pc-workspace-terminal__panes"), pane: box(".pc-workspace-terminal__pane"), term: box(".pc-terminal-pane") };
    });
    expect(sizes.panes).toBeGreaterThanOrEqual(sizes.body * 0.55);
    expect(sizes.panes).toBeGreaterThanOrEqual(150);
    expect(sizes.pane).toBeLessThanOrEqual(sizes.panes);
    // The terminal itself keeps several lines (about 16px each) once search, status and controls are compacted.
    expect(sizes.term).toBeGreaterThanOrEqual(100);
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
      await page.keyboard.press("ControlOrMeta+b");
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

browserTest("panel_toggle_keeps_focus_on_its_control", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
    await open(page, built, "#/settings");
    // Pointer and keyboard toggles swap the control; focus follows it instead of falling to the body.
    await page.getByRole("button", { name: "Hide Settings" }).click();
    await focused(page, '[aria-label="Show Settings"]');
    await page.keyboard.press("Enter");
    await focused(page, '[aria-label="Hide Settings"]');
    // Mod-b from a link inside the panel removes that link; focus moves to the reopen control.
    await page.getByRole("complementary", { name: "Settings" }).getByRole("link").first().focus();
    await page.keyboard.press("ControlOrMeta+b");
    await focused(page, '[aria-label="Show Settings"]');
    // Mod-b from the work area leaves focus where it was.
    await page.locator("#main-content").focus();
    await page.keyboard.press("ControlOrMeta+b");
    await page.getByRole("complementary", { name: "Settings" }).waitFor();
    await focused(page, "#main-content");
  } finally { await browser.close(); }
}, 20_000);

browserTest("panels_and_dock_not_offered_where_hidden", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    // Between the narrow breakpoint and 768px the shell hides side panels, so Mod-b must not be registered.
    const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
    await open(page, built, "#/settings");
    expect(await page.getByRole("button", { name: /^(Hide|Show) Settings$/ }).count()).toBe(0);
    await page.locator("#main-content").focus();
    await page.keyboard.press("ControlOrMeta+b");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => localStorage.getItem("pacer.panel.settings"))).toBeNull();
    // The dock is not offered there either: no status-bar control, and Ctrl-` does nothing.
    expect(await page.getByRole("button", { name: "Terminal", exact: true }).count()).toBe(0);
    await page.keyboard.press("Control+Backquote");
    await page.waitForTimeout(100);
    expect(await page.getByRole("region", { name: "Terminal panel" }).count()).toBe(0);
  } finally { await browser.close(); }
}, 20_000);
