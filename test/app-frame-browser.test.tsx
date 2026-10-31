import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it these checks skip.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);

async function frame(setupOpen = 0) {
  const build = await Bun.build({ entrypoints: ["test/fixtures/app-frame-browser.tsx"], target: "browser", splitting: false, plugins: [{ name: "stub-pty-view", setup(builder) {
    builder.onLoad({ filter: /snapshot\.json$/ }, async args => {
      const snapshot = await Bun.file(args.path).json();
      snapshot.counts.setupOpen = setupOpen;
      return { contents: JSON.stringify(snapshot), loader: "json" };
    });
    builder.onResolve({ filter: /term\/LazyTerminal$/ }, () => ({ path: "stub", namespace: "terminal-stub" }));
    builder.onLoad({ filter: /.*/, namespace: "terminal-stub" }, () => ({ resolveDir: process.cwd(), loader: "js", contents: `import { h } from "preact";
    export const LazyTerminal = () => h("section", { class: "pc-terminal-view" },
      h("div", { class: "pc-terminal-frame" }, h("div", { class: "pc-terminal-pane" })));` }));
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

browserTest("web_frame_scrolls_work_without_moving_chrome", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 700, height: 812 }]) {
      const page = await browser.newPage({ viewport });
      await open(page, built, "#/dispatch");
      // Add enough real flowing content to exceed either viewport without changing the frame's styles.
      await page.locator("#main-content").evaluate(main => {
        const navigation = document.createElement("nav");
        navigation.className = "pc-detail-navigation";
        navigation.textContent = "Detail navigation";
        main.prepend(navigation);
        const session = document.createElement("section");
        session.className = "pc-session-main";
        const tabs = document.createElement("div");
        tabs.className = "pc-tabs";
        tabs.textContent = "Session tabs";
        session.append(tabs);
        main.append(session);
        for (let i = 0; i < 100; i++) {
          const row = document.createElement("p");
          row.textContent = `Work item ${i + 1}`;
          session.append(row);
        }
      });
      const geometry = () => page.evaluate(() => {
        const work = document.querySelector<HTMLElement>(".pc-work")!;
        const bar = document.querySelector(".pc-statusbar, .pc-bottom-bar")!;
        return {
          documentHeight: document.scrollingElement!.scrollHeight,
          documentTop: document.scrollingElement!.scrollTop,
          workHeight: work.clientHeight,
          workScrollHeight: work.scrollHeight,
          workTop: work.scrollTop,
          top: document.querySelector(".pc-topbar")!.getBoundingClientRect().y,
          workBottom: work.getBoundingClientRect().bottom,
          barTop: bar.getBoundingClientRect().top,
          barBottom: bar.getBoundingClientRect().bottom,
        };
      });
      const before = await geometry();
      expect(before.documentHeight).toBe(viewport.height);
      expect(before.workScrollHeight).toBeGreaterThan(before.workHeight);
      expect(before.top).toBe(0);
      expect(before.workBottom).toBeLessThanOrEqual(before.barTop);
      expect(before.barBottom).toBe(viewport.height);
      await page.locator(".pc-work").hover();
      await page.mouse.wheel(0, 500);
      await page.waitForFunction(() => document.querySelector(".pc-work")!.scrollTop > 0);
      const after = await geometry();
      expect(after.documentHeight).toBe(viewport.height);
      expect(after.documentTop).toBe(0);
      expect(after.workTop).toBeGreaterThan(0);
      expect(after.top).toBe(0);
      if (viewport.width >= 768) {
        const sticky = await page.evaluate(() => ({
          workTop: document.querySelector(".pc-work")!.getBoundingClientRect().top,
          navigationTop: document.querySelector(".pc-detail-navigation")!.getBoundingClientRect().top,
          tabsTop: document.querySelector(".pc-session-main > .pc-tabs")!.getBoundingClientRect().top,
        }));
        expect(sticky.navigationTop).toBe(sticky.workTop);
        expect(sticky.tabsTop).toBe(sticky.workTop);
      }
      // At the end of the work area, the final content remains above the fixed bottom bar.
      await page.locator(".pc-work").evaluate(work => { work.scrollTop = work.scrollHeight; });
      const lastBottom = await page.locator("#main-content .pc-session-main > p").last().evaluate(row => row.getBoundingClientRect().bottom);
      expect(lastBottom).toBeLessThanOrEqual((await geometry()).barTop);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

browserTest("tasks_list_restores_work_scroll_on_back", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 500 }]) {
      const page = await browser.newPage({ viewport });
      await open(page, built, "?task-list#/sessions");
      await page.locator(".pc-task-card").first().waitFor();
      // Let initial loading and route effects settle before the user scrolls.
      await page.waitForTimeout(250);
      for (const position of [200, 350]) {
        await page.locator(".pc-work").evaluate((work, y) => { work.scrollTop = y; }, position);
        await page.waitForFunction(y => Math.abs(document.querySelector(".pc-work")!.scrollTop - y) <= 1, position);
        await page.waitForTimeout(50); // Deliver the scroll event that saves the list position.
        // Activate a real row link without Playwright scrolling it into view first.
        await page.locator('.pc-task-card a[href*="scroll-task-"]').first().evaluate(link => (link as HTMLElement).click());
        await page.waitForFunction(() => location.hash.startsWith("#/workspace?task="));
        await page.waitForFunction(() => document.querySelector(".pc-work")!.scrollTop === 0);
        // Model rows whose layout becomes available after the first restoration frame.
        await page.evaluate(() => {
          const style = document.createElement("style");
          style.id = "delayed-task-layout";
          style.textContent = ".pc-tasks-page { display: none; }";
          document.head.append(style);
          setTimeout(() => style.remove(), 600);
        });
        await page.goBack();
        await page.locator(".pc-task-card").first().waitFor();
        await page.waitForFunction(y => Math.abs(document.querySelector(".pc-work")!.scrollTop - y) <= 1, position, { timeout: 2000 });
        // Restoration must survive the parent's route reset and focus effects.
        await page.waitForTimeout(250);
        expect(await page.locator(".pc-work").evaluate(work => work.scrollTop)).toBeCloseTo(position, 0);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

browserTest("tasks_accessible_labels_stay_inside_the_work_scrollport", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      await open(page, built, "#/tasks");
      // Reproduce the Tasks list's unpositioned flex rows and absolute accessible labels.
      await page.locator("#main-content").evaluate(main => {
        const list = document.createElement("section");
        list.setAttribute("aria-label", "Tasks");
        for (let i = 0; i < 50; i++) {
          const card = document.createElement("article");
          card.className = "pc-task-card";
          const row = document.createElement("div");
          row.className = "pc-task-card__row pc-task-card__row--head";
          const label = document.createElement("span");
          label.className = "sr-only";
          label.textContent = "Running: ";
          const title = document.createElement("span");
          title.className = "pc-task-card__title";
          title.textContent = `Task ${i + 1}`;
          row.append(label, title);
          card.append(row);
          list.append(card);
        }
        main.replaceChildren(list);
      });
      const geometry = () => page.evaluate(() => {
        const root = document.scrollingElement!, work = document.querySelector(".pc-work")!;
        return { documentHeight: root.scrollHeight, documentTop: root.scrollTop, workTop: work.scrollTop,
          workHeight: work.clientHeight, workScrollHeight: work.scrollHeight };
      });
      const before = await geometry();
      expect(before.documentHeight).toBe(viewport.height);
      expect(before.workScrollHeight).toBeGreaterThan(before.workHeight);
      await page.locator(".pc-work").hover();
      await page.mouse.wheel(0, 500);
      await page.waitForFunction(() => document.querySelector(".pc-work")!.scrollTop > 0);
      expect((await geometry()).documentTop).toBe(0);
      await page.locator(".pc-work").evaluate(work => { work.scrollTop = work.scrollHeight; });
      await page.mouse.wheel(0, 500);
      // Allow scroll chaining to reach the document if any absolute descendant escaped.
      await page.waitForTimeout(150);
      await page.evaluate(() => window.scrollTo(0, 400));
      const after = await geometry();
      expect(after.documentHeight).toBe(viewport.height);
      expect(after.documentTop).toBe(0);
      expect(after.workTop).toBeGreaterThan(0);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

browserTest("narrow_settings_topbar_touches_the_tab_strip", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const hash of ["#/settings", "#/settings/app", "#/settings/dispatcher", "#/settings/executors"]) {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
      await open(page, built, hash);
      const geometry = () => page.evaluate(() => ({
        tabsBottom: document.querySelector(".pc-panel")!.getBoundingClientRect().bottom,
        topbarTop: document.querySelector(".pc-topbar")!.getBoundingClientRect().top,
        documentHeight: document.scrollingElement!.scrollHeight,
        documentTop: document.scrollingElement!.scrollTop,
      }));
      const before = await geometry();
      expect(before.topbarTop).toBe(before.tabsBottom);
      expect(before.documentHeight).toBe(812);
      await page.locator("#main-content").evaluate(main => {
        for (let i = 0; i < 100; i++) {
          const row = document.createElement("p");
          row.textContent = `Setting ${i + 1}`;
          main.append(row);
        }
      });
      await page.locator(".pc-work").evaluate(work => { work.scrollTop = 400; });
      const after = await geometry();
      expect(after.topbarTop).toBe(after.tabsBottom);
      expect(after.documentHeight).toBe(812);
      expect(after.documentTop).toBe(0);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

browserTest("dock_focus_moves_in_and_returns", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built, "#/");
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
    await page.getByRole("button", { name: "New terminal", exact: true }).click();
    await dock.getByRole("tablist", { name: "Terminals" }).getByRole("tab", { name: "Shell", exact: true }).last().waitFor();
    expect(await page.evaluate(() => location.hash)).toBe("#/");
    // The shell gets most of the 320px dock: toolbar, tabs and actions share a few compact rows.
    const sizes = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().height;
      return { body: box(".pc-workspace-terminal"), panes: box(".pc-workspace-terminal__panes"), pane: box(".pc-workspace-terminal__pane"), term: box(".pc-terminal-pane") };
    });
    expect(sizes.panes).toBeGreaterThanOrEqual(sizes.body * 0.55);
    expect(sizes.panes).toBeGreaterThanOrEqual(150);
    expect(sizes.pane).toBeLessThanOrEqual(sizes.panes);
    // The terminal itself keeps several lines (about 16px each) once search, status and controls are compacted.
    expect(sizes.term).toBeGreaterThanOrEqual(100);
    expect(await dock.getByRole("tab", { name: "Shell", exact: true }).count()).toBe(2);
    await expect(dock.getByRole("tab", { name: "Shell", exact: true }).last().getAttribute("aria-selected")).resolves.toBe("true");
    await dock.focus();
    await page.getByRole("button", { name: "Hide panel (Ctrl+`)" }).click();
    await expect(dock.count()).resolves.toBe(0);
    await focused(page, "#main-content");
    // The terminal route has no dock and no dock control.
    await page.evaluate(() => { location.hash = "#/workspace"; });
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
      const hide = page.getByRole("button", { name: "Toggle left panel" });
      await expect(hide.getAttribute("aria-pressed")).resolves.toBe("true");
      await hide.click();
      await expect(panel.count()).resolves.toBe(0);
      expect(await noHorizontalOverflow(page)).toBe(true);
      const show = page.getByRole("button", { name: "Toggle left panel" });
      await expect(show.getAttribute("aria-pressed")).resolves.toBe("false");
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
    await page.getByRole("button", { name: "Toggle left panel" }).click();
    await focused(page, '[aria-label="Toggle left panel"]');
    await page.keyboard.press("Enter");
    await focused(page, '[aria-label="Toggle left panel"]');
    // Mod-b from a link inside the panel removes that link; focus moves to the reopen control.
    await page.getByRole("complementary", { name: "Settings" }).getByRole("link").first().focus();
    await page.keyboard.press("ControlOrMeta+b");
    await focused(page, '[aria-label="Toggle left panel"]');
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
        top: { h: size(top)[1], pad: css(top).padding, bg: css(top).backgroundColor, card: css(rail).backgroundColor, headings: top.querySelectorAll("h1").length, label: top.getAttribute("aria-label") },
        mark: size(q(".pc-topbar__brand svg")), delegate: (() => { const b = [...document.querySelectorAll(".pc-topbar .pc-btn")].find(x => x.textContent === "New task")!; return [b.className, getComputedStyle(b).backgroundColor, getComputedStyle(document.querySelector(".pc-topbar")!).backgroundColor]; })(), toggleRadius: css(toggles[0]!).borderTopLeftRadius,
        badgeType: [css(badge).fontSize, css(badge).fontWeight, css(badge).color], chip: { h: size(chip)[1], r: css(chip).borderTopLeftRadius, mode: !!chip.querySelector(".pc-pill") },
        toggles: toggles.map(size), names: toggles.map(t => t.getAttribute("aria-label")), group: q(".pc-layout-toggles").getAttribute("aria-label"),
        rail: { w: size(rail)[0], pad: css(rail).padding, gap: css(rail).rowGap, item: size(on), bar: [css(on, "::before").width, css(on, "::before").height, css(on, "::before").left, css(on, "::before").backgroundColor], onBg: css(on).backgroundColor, lane: css(q(".pc-rail__divider")).height },
        badge: { size: size(badge), bg: css(badge).backgroundColor, radius: css(badge).borderTopLeftRadius },
        status: { h: size(status)[1], pad: css(status).padding, gap: css(status).columnGap, meter: size(q(".pc-statusbar .pc-meter--mini")), mark: size(q(".pc-statusbar__item .pc-agent-mark")), work: q(".pc-statusbar__work").textContent, keys: q(".pc-statusbar__keys").textContent, family: css(q(".pc-statusbar__keys")).fontFamily },
        overflow: document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth,
      };
    });
    expect(m.top.h).toBe(36);
    expect(m.top.pad).toBe("0px 10px 0px 84px");
    expect(m.top.bg).toBe(m.top.card);
    expect(m.top.headings).toBe(0); // Settings pages supply the h1; the banner retains its name.
    expect(m.top.label).toBe("Settings");
    expect(m.mark).toEqual([18, 18]);
    expect(m.chip.h).toBe(24);
    expect(m.chip.r).not.toBe("0px");
    expect(m.chip.mode).toBe(true);
    expect(m.group).toBe("Layout");
    expect(m.toggles).toEqual([[28, 28], [28, 28], [28, 28]]); // left panel and terminal; no right panel on this route
    expect(m.names).toEqual(["Toggle left panel", "Toggle terminal panel (Ctrl+`)", "Toggle right panel"]);
    expect(m.rail.w).toBe(52);
    expect(m.rail.pad).toBe("8px 0px");
    expect(m.rail.gap).toBe("4px");
    expect(m.rail.item).toEqual([40, 40]);
    expect(m.rail.bar.slice(0, 3)).toEqual(["3px", "20px", "-6px"]);
    expect(m.badge.size[1]).toBe(16);
    expect(m.badgeType.slice(0, 3)).toEqual(["11px", "700", "rgb(255, 255, 255)"]); // light theme; dark is covered by the contrast test
    expect(m.delegate[0]).toContain("pc-btn--secondary");
    expect(m.delegate[1]).not.toBe("rgb(24, 24, 27)"); // not the filled primary
    expect(m.delegate[1]).not.toBe("rgb(9, 9, 11)");
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
    // Workspace owns its two side panels; its terminal dock toggle stays disabled.
    await page.evaluate(() => { location.hash = "#/workspace"; });
    await page.waitForFunction(() => { const buttons = [...document.querySelectorAll<HTMLButtonElement>(".pc-layout-toggles button")]; return buttons.length === 3 && !buttons[0]!.disabled && buttons[1]!.disabled && !buttons[2]!.disabled; });
    // Below 768px panels and the dock are hidden, so their toggles go too, and nothing overflows.
    await page.evaluate(() => { location.hash = "#/settings"; });
    await page.setViewportSize({ width: 767, height: 800 });
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".pc-layout-toggles button")].length === 3 && [...document.querySelectorAll<HTMLButtonElement>(".pc-layout-toggles button")].every(button => button.disabled), null, { timeout: 2000 });
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

browserTest("count_badge_text_keeps_contrast_in_both_themes", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const luminance = (rgb: string) => { const [r, g, b] = rgb.match(/\d+/g)!.map(Number).map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      await open(page, built, "#/settings");
      const colors = await page.locator(".pc-rail__badge--count").first().evaluate(node => ({ fg: getComputedStyle(node).color, bg: getComputedStyle(node).backgroundColor }));
      const [hi, lo] = [luminance(colors.fg), luminance(colors.bg)].sort((a, b) => b - a);
      expect((hi! + 0.05) / (lo! + 0.05)).toBeGreaterThanOrEqual(4.5);
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

for (const setupOpen of [0, 1]) {
  browserTest(`bottom navigation has five nonoverlapping board touch targets with setupOpen=${setupOpen}`, async () => {
    const built = await frame(setupOpen);
    const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true });
      await open(page, built, "#/settings");
      const nav = page.locator(".pc-bottom-bar");
      await nav.waitFor();
      const targets = await nav.locator("a, button").evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        return { label: node.getAttribute("aria-label"), left: box.left, right: box.right, width: box.width, height: box.height };
      }));
      expect(targets).toHaveLength(5);
      expect(targets.some(t => t.label === "Dispatch")).toBe(true);
      expect(targets.some(t => t.label === "Insights")).toBe(true);
      expect(targets.some(t => t.label?.startsWith("Setup"))).toBe(false);
      expect(targets.some(t => t.label === "Dispatcher")).toBe(false);
      expect(targets.some(t => t.label === "Tasks")).toBe(true);
      expect(targets.some(t => t.label?.startsWith("Needs you"))).toBe(true);
      expect(targets.some(t => t.label?.startsWith("Settings"))).toBe(true);
      for (const [i, target] of targets.entries()) {
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBe(56);
        expect(target.right).toBeLessThanOrEqual(375);
        if (i > 0) expect(target.left).toBeGreaterThanOrEqual(targets[i - 1]!.right);
      }
      expect(await noHorizontalOverflow(page)).toBe(true);
    } finally { await browser.close(); }
  }, 30_000);
}

 browserTest("terminal dock service controls disable offline and recover without changing landmarks", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built, "#/dispatch");
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const panel = page.getByRole("region", { name: "Terminal panel", exact: true });
    await panel.waitFor();
    const controls = [panel.getByRole("button", { name: "New terminal", exact: true }), panel.getByRole("button", { name: "New terminal in…", exact: true })];
    for (const connected of [false, true]) {
      await page.evaluate(value => window.dispatchEvent(new CustomEvent("fixture-connection", { detail: value })), connected);
      await page.waitForFunction(value => !!document.querySelector(".connection-bar") === !value, connected);
      for (const control of controls) {
        expect(await control.isDisabled()).toBe(!connected);
        if (!connected) expect(await control.locator("xpath=ancestor::fieldset").getAttribute("title")).toBe("pacer is offline");
      }
      expect(await panel.count()).toBe(1);
    }
  } finally { await browser.close(); }
}, 30_000);

browserTest('canvas_shell_dock_is_centre_only_and_navigation_uses_live_controls', async () => {
  const built = await frame();
  const browser = await chromium.launch({executablePath:browserPath!,headless:true});
  try {
    for (const width of [1440,1920]) {
      const page=await browser.newPage({viewport:{width,height:900}});
      await open(page,built,'#/');
      expect(await page.locator('.pc-planner').getAttribute('href')).toBe('#/settings/planner');
      expect(await page.locator('.pc-statusbar__work').getAttribute('href')).toBe('#/tasks');
      await page.getByRole('button',{name:'Toggle terminal panel (Ctrl+`)'}).click();
      await page.locator('#pc-terminal-dock').waitFor();
      const geometry=await page.evaluate(()=>{
        const rect=(s:string)=>document.querySelector(s)!.getBoundingClientRect();
        const dock=rect('#pc-terminal-dock'),centre=rect('.pc-work-wrap'),rail=rect('.pc-rail');
        const search=document.querySelector('.pc-topbar__new')!;
        return {dock:{left:dock.left,right:dock.right,height:dock.height},centre:{left:centre.left,right:centre.right},railBottom:rail.bottom,centreBottom:centre.bottom,newHeight:search.getBoundingClientRect().height,plugins:getComputedStyle(document.querySelector('.pc-rail__plugins-label')!).fontSize,pluginBounds:(()=>{const el=document.querySelector('.pc-rail__plugins-label')!;const r=document.createRange();r.selectNodeContents(el);const b=r.getBoundingClientRect();return {left:b.left,right:b.right};})(),statusButtons:[...document.querySelectorAll('.pc-statusbar .pc-btn')].map(e=>e.getBoundingClientRect().height)};
      });
      expect(geometry.pluginBounds.left).toBeGreaterThanOrEqual(4);
      expect(geometry.pluginBounds.right).toBeLessThanOrEqual(48);
      expect(geometry.dock.left).toBe(geometry.centre.left);
      expect(geometry.dock.right).toBe(geometry.centre.right);
      expect(Math.abs(geometry.dock.height-260)).toBeLessThan(2);
      expect(geometry.railBottom).toBe(geometry.centreBottom);
      expect(geometry.newHeight).toBe(26);
      expect(geometry.plugins).toBe('11px');
      expect(geometry.statusButtons.every(h=>h<=28)).toBe(true);
      await page.close();
    }
  } finally {await browser.close();}
},30000);

browserTest("rail_tooltips_escape_stacking_context_and_fit_the_viewport", async () => {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built, "#/settings");
    const trigger = page.getByRole("link", { name: "Workspace", exact: true });
    const active = page.locator('.pc-rail__item.on').first();
    const activeBackground = await active.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(await active.evaluate(el => getComputedStyle(el, "::before").width)).toBe("3px");
    await active.hover();
    expect(await active.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(activeBackground);
    const inactiveBackground = await trigger.evaluate(el => getComputedStyle(el).backgroundColor);
    await trigger.hover();
    expect(await trigger.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(inactiveBackground);
    expect(await trigger.getAttribute("aria-current")).toBeNull();
    const bubble = page.getByRole("tooltip");
    await bubble.waitFor({ state: "visible" });
    expect(await bubble.evaluate(el => el.parentElement === document.body)).toBe(true);
    expect(await bubble.textContent()).toBe("Workspace");
    const measure = () => bubble.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, height: rect.height, position: style.position, background: style.backgroundColor, z: Number(style.zIndex) };
    });
    const initial = await measure();
    const anchor = (await trigger.boundingBox())!;
    expect(initial.x - anchor.x - anchor.width).toBeCloseTo(8, 0);
    expect(initial.y + initial.height / 2).toBeCloseTo(anchor.y + anchor.height / 2, 0);
    expect(initial.position).toBe("fixed");
    expect(initial.z).toBeGreaterThanOrEqual(10);
    expect(initial.background).not.toMatch(/rgba\(.*?, 0\)/);
    await trigger.focus();
    await page.mouse.move(900, 800);
    await bubble.waitFor({ state: "visible" });
    // Move the rail into a clipped stacking context at each viewport edge.
    for (const at of [{ right: "0", top: "0" }, { right: "0", bottom: "0" }]) {
      await trigger.evaluate((el, at) => {
        const rail = el.closest<HTMLElement>(".pc-rail")!;
        rail.style.cssText = `position:fixed;left:auto;right:${at.right};top:${at.top ?? "auto"};bottom:${at.bottom ?? "auto"};height:auto;overflow:hidden;transform:translateZ(0)`;
      }, at);
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      const placed = await measure();
      const moved = (await trigger.boundingBox())!;
      expect(placed.right).toBeLessThanOrEqual(moved.x - 7);
      expect(placed.x).toBeGreaterThanOrEqual(8);
      expect(placed.y).toBeGreaterThanOrEqual(8);
      expect(placed.bottom).toBeLessThanOrEqual(892);
    }
    await trigger.evaluate(el => el.closest(".pc-rail")!.removeAttribute("style"));
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await trigger.focus();
    await page.keyboard.press("Escape");
    await bubble.waitFor({ state: "hidden" });
    await trigger.hover();
    await bubble.waitFor({ state: "visible" });
    await page.mouse.move(600, 400);
    await bubble.waitFor({ state: "visible" }); // Still focused after Escape and re-entry.
    await page.keyboard.press("Escape");
    await page.mouse.move(610, 400);
    await bubble.waitFor({ state: "hidden" });
    await page.close();
  } finally { await browser.close(); }
}, 20_000);
