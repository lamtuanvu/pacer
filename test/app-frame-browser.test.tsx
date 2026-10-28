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
    // Ctrl-b from a link inside the panel removes that link; focus moves to the reopen control.
    await page.getByRole("complementary", { name: "Settings" }).getByRole("link").first().focus();
    await page.keyboard.press("Control+b");
    await focused(page, '[aria-label="Show Settings"]');
    // Ctrl-b from the work area leaves focus where it was.
    await page.locator("#main-content").focus();
    await page.keyboard.press("Control+b");
    await page.getByRole("complementary", { name: "Settings" }).waitFor();
    await focused(page, "#main-content");
  } finally { await browser.close(); }
}, 20_000);

browserTest("panels_and_dock_not_offered_where_hidden", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    // Between the narrow breakpoint and 768px the shell hides side panels, so Ctrl-b must not be registered.
    const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
    await open(page, built, "#/settings");
    expect(await page.getByRole("button", { name: /^(Hide|Show) Settings$/ }).count()).toBe(0);
    await page.locator("#main-content").focus();
    await page.keyboard.press("Control+b");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => localStorage.getItem("pacer.panel.settings"))).toBeNull();
    // The dock is not offered there either: no status-bar control, and Ctrl-` does nothing.
    expect(await page.getByRole("button", { name: "Terminal", exact: true }).count()).toBe(0);
    await page.keyboard.press("Control+Backquote");
    await page.waitForTimeout(100);
    expect(await page.getByRole("region", { name: "Terminal panel" }).count()).toBe(0);
  } finally { await browser.close(); }
}, 20_000);

browserTest("frame_chrome_measures_to_the_board", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built, "#/settings");
    const m = await page.evaluate(() => {
      const q = (s: string) => document.querySelector(s) as HTMLElement, css = (e: Element, p?: string) => getComputedStyle(e, p);
      const size = (e: Element) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; };
      const top = q(".pc-topbar"), rail = q(".pc-rail"), status = q(".pc-statusbar"), on = q(".pc-rail__item.on");
      const badge = q(".pc-rail__badge--count"), chip = q(".pc-planner"), toggles = [...document.querySelectorAll(".pc-layout-toggles button")];
      return {
        top: { h: size(top)[1], pad: css(top).padding, bg: css(top).backgroundColor, card: css(rail).backgroundColor, h1: size(q(".pc-topbar h1")) },
        mark: size(q(".pc-topbar__brand svg")), delegate: [...document.querySelectorAll(".pc-topbar .pc-btn")].find(b => b.textContent === "Delegate")!.className, toggleRadius: css(toggles[0]!).borderTopLeftRadius,
        badgeType: [css(badge).fontSize, css(badge).fontWeight, css(badge).color], chip: { h: size(chip)[1], r: css(chip).borderTopLeftRadius, mode: !!chip.querySelector(".pc-pill") },
        toggles: toggles.map(size), names: toggles.map(t => t.getAttribute("aria-label")), group: q(".pc-layout-toggles").getAttribute("aria-label"),
        rail: { w: size(rail)[0], pad: css(rail).padding, gap: css(rail).rowGap, item: size(on), bar: [css(on, "::before").width, css(on, "::before").height, css(on, "::before").left, css(on, "::before").backgroundColor], onBg: css(on).backgroundColor, lane: css(q(".pc-rail__divider")).height },
        badge: { size: size(badge), bg: css(badge).backgroundColor, radius: css(badge).borderTopLeftRadius },
        status: { h: size(status)[1], pad: css(status).padding, gap: css(status).columnGap, meter: size(q(".pc-statusbar .pc-meter--mini")), mark: size(q(".pc-statusbar__item .pc-agent-mark")), work: q(".pc-statusbar__work").textContent, keys: q(".pc-statusbar__keys").textContent, family: css(q(".pc-statusbar__keys")).fontFamily },
        overflow: document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth,
      };
    });
    expect(m.top.h).toBe(44);
    expect(m.top.pad).toBe("0px 10px 0px 8px");
    expect(m.top.bg).toBe(m.top.card);
    expect(m.top.h1[0]).toBeLessThanOrEqual(1); // visually hidden: the page title stays for assistive technology
    expect(m.mark).toEqual([18, 18]);
    expect(m.chip.h).toBe(28);
    expect(m.chip.r).not.toBe("0px");
    expect(m.chip.mode).toBe(true);
    expect(m.group).toBe("Layout");
    expect(m.toggles).toEqual([[32, 32], [32, 32]]); // left panel and terminal; no right panel on this route
    expect(m.names).toEqual(["Toggle left panel", "Toggle terminal panel (Ctrl+`)"]);
    expect(m.rail.w).toBe(52);
    expect(m.rail.pad).toBe("8px 0px");
    expect(m.rail.gap).toBe("4px");
    expect(m.rail.item).toEqual([40, 40]);
    expect(m.rail.bar.slice(0, 3)).toEqual(["3px", "20px", "-6px"]);
    expect(m.badge.size[1]).toBe(16);
    expect(m.badgeType).toEqual(["10px", "700", "rgb(255, 255, 255)"]);
    expect(m.delegate).toContain("pc-btn--secondary");
    expect(m.toggleRadius).toBe("6px");
    expect(m.badge.radius).not.toBe("0px");
    expect(m.status.h).toBe(28);
    expect(m.status.pad).toBe("0px 10px");
    expect(m.status.gap).toBe("14px");
    expect(m.status.meter).toEqual([28, 4]);
    expect(m.status.mark).toEqual([16, 16]);
    expect(m.status.work).toMatch(/^\d+ running · \d+ queued$/);
    expect(m.status.keys).toBe("Ctrl+`");
    expect(m.overflow).toBe(true);
    // The toggles drive the real panels and dock, and report their state.
    await expect(page.getByRole("button", { name: "Toggle left panel" }).getAttribute("aria-pressed")).resolves.toBe("true");
    await expect(page.getByRole("button", { name: "Toggle terminal panel (Ctrl+`)" }).getAttribute("aria-pressed")).resolves.toBe("false");
    await page.getByRole("button", { name: "Toggle left panel" }).click();
    await expect(page.getByRole("complementary", { name: "Settings" }).count()).resolves.toBe(0);
    await expect(page.getByRole("button", { name: "Toggle left panel" }).getAttribute("aria-pressed")).resolves.toBe("false");
    await page.getByRole("button", { name: "Toggle terminal panel (Ctrl+`)" }).click();
    await page.getByRole("region", { name: "Terminal panel" }).waitFor();
    await expect(page.getByRole("button", { name: "Toggle terminal panel (Ctrl+`)" }).getAttribute("aria-pressed")).resolves.toBe("true");
    // A route without panels or dock offers no toggles; narrow layouts keep their own chrome.
    await page.evaluate(() => { location.hash = "#/terminal"; });
    await page.locator(".pc-layout-toggles button").first().waitFor({ state: "detached" });
    // Below 768px panels and the dock are hidden, so their toggles go too, and nothing overflows.
    await page.evaluate(() => { location.hash = "#/settings"; });
    await page.setViewportSize({ width: 767, height: 800 });
    await page.waitForFunction(() => !document.querySelector(".pc-layout-toggles button"), null, { timeout: 2000 });
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForFunction(() => !document.querySelector(".pc-statusbar"), null, { timeout: 2000 });
    await expect(page.locator(".pc-rail, .pc-statusbar, .pc-layout-toggles").count()).resolves.toBe(0);
    expect(await noHorizontalOverflow(page)).toBe(true);
  } finally { await browser.close(); }
}, 30_000);

browserTest("settings_attention_dot_measures_to_the_board", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      await open(page, built, "#/settings");
      const link = page.getByRole("link", { name: /^Settings, 2 agents need attention$/ });
      await link.waitFor();
      const dot = await link.locator(".pc-rail__dot").evaluate(node => { const css = getComputedStyle(node), card = getComputedStyle(document.querySelector(".pc-rail")!), r = node.getBoundingClientRect();
        return { content: [parseFloat(css.width), parseFloat(css.height)], border: [css.borderTopWidth, css.borderTopColor === card.backgroundColor], fill: css.backgroundColor, box: [r.width, r.height] }; });
      expect(dot.content).toEqual([8, 8]);
      expect(dot.border).toEqual(["2px", true]);
      expect(dot.box).toEqual([12, 12]);
      expect(dot.fill).toBe(scheme === "light" ? "rgb(220, 38, 38)" : "rgb(239, 68, 68)");
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);
