import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it these checks skip.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
type Scenario = "conversation" | "supervised" | "ended";

let built: Promise<{ source: string; css: string }> | undefined;
function sessionScreen() {
  return built ??= (async () => {
    const build = await Bun.build({ entrypoints: ["test/fixtures/session-screen-browser.tsx"], target: "browser", splitting: false, plugins: [{ name: "stub-pty-view", setup(builder) {
      builder.onResolve({ filter: /term\/LazyTerminal$/ }, () => ({ path: "stub", namespace: "terminal-stub" }));
      builder.onLoad({ filter: /.*/, namespace: "terminal-stub" }, () => ({ contents: "import { h } from 'preact'; export const LazyTerminal = () => h('div', { className: 'pc-terminal-stub', tabIndex: 0, 'aria-label': 'Agent terminal' });", loader: "js" }));
    } }] });
    expect(build.success).toBe(true);
    const css = [generateTokensCss(readTokens("app/src/ds")), ...await Promise.all(["app/src/ds/components.css", "app/src/ds/feedback.css", "app/src/styles.css", "app/src/screens/session/session.css", "app/src/screens/terminal/terminal.css", "app/src/screens/work/work.css"].map(path => Bun.file(path).text()))].join("\n");
    return { source: await build.outputs[0]!.text(), css };
  })();
}
async function openSession(browser: Browser, scenario: Scenario, viewport = { width: 1440, height: 900 }, colorScheme: "light" | "dark" = "light") {
  const { source, css } = await sessionScreen();
  const page = await browser.newPage({ viewport, colorScheme });
  await page.route("http://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>session</title><div id="app"></div>' }));
  await page.goto("http://pacer.test/#/tasks/t-0412");
  await page.evaluate(([css, scenario]) => { document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`); (window as any).SCENARIO = scenario; }, [css, scenario] as const);
  await page.evaluate(async code => { const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })); await import(url); URL.revokeObjectURL(url); }, source);
  await page.locator(".pc-session-title-actions").first().waitFor({ state: "attached" });
  return page;
}
const focused = (page: Page, selector: string) => page.waitForFunction(at => document.activeElement?.matches(at), selector, { timeout: 2000 })
  .catch(async error => { throw new Error(`${error.message}; focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))}`); });
const calls = (page: Page) => page.evaluate(() => (window as any).CALLS.map((call: { op: string }) => call.op) as string[]);
async function withBrowser(run: (browser: Browser) => Promise<void>) {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try { await run(browser); } finally { await browser.close(); }
}

browserTest("end_session_icon_confirms", async () => withBrowser(async browser => {
  for (const scenario of ["conversation", "supervised"] as const) {
    const page = await openSession(browser, scenario);
    const actions = page.getByRole("banner").getByRole("group", { name: "Layout", exact: true });
    const end = actions.getByRole("button", { name: "End session" });
    await expect(end.getAttribute("class")).resolves.toContain("pc-btn--quiet");
    await expect(end.getAttribute("title")).resolves.toBe("End session (asks to confirm)");
    expect(await actions.getByRole("button").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")).slice(-2))).toEqual(["Toggle details panel", "End session"]);
    expect(await end.evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))).toEqual({ width: 30, height: 30 });
    expect(await end.evaluate(node => {
      const expected = document.createElement("span"); expected.style.color = "var(--bad-fg)"; node.append(expected);
      const matches = getComputedStyle(node).color === getComputedStyle(expected).color; expected.remove(); return matches;
    })).toBe(true);
    // Cancelling the existing confirm dialog ends nothing and returns focus to the icon.
    await end.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await calls(page)).not.toContain(scenario === "conversation" ? "session.end" : "task.stop");
    await focused(page, '[aria-label="End session"]');
    // Confirming from the keyboard ends the session.
    await page.keyboard.press("Enter");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: scenario === "conversation" ? "End session" : "Stop" }).click();
    await page.waitForFunction(op => (window as any).CALLS.some((call: { op: string }) => call.op === op), scenario === "conversation" ? "session.end" : "task.stop");
    // Once ended, End session leaves the title bar and focus stays in the title bar instead of falling to the page.
    await end.waitFor({ state: "detached" });
    await focused(page, ".pc-topbar button");
    await page.close();
  }
}), 60_000);

browserTest("changes_tab_lists_worktree_files", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation");
  const panel = page.getByRole("complementary", { name: "Session details" });
  const changes = panel.getByRole("tab", { name: "Changes" });
  await changes.click();
  await expect(changes.getAttribute("aria-selected")).resolves.toBe("true");
  const tabpanel = panel.getByRole("tabpanel", { name: "Changes" });
  const files = tabpanel.getByRole("list", { name: "Changed files" }).getByRole("listitem");
  await files.first().waitFor();
  expect(await files.allInnerTexts()).toEqual(["src/example.ts\n+3 −1", expect.stringContaining("demo-stages-frames.md"), "reports/frames/stage-2.png\nnew"]);
  // A long path clips inside the 320px panel, keeping the full path in its title.
  const long = tabpanel.locator('[title$="demo-stages-frames.md"]');
  expect(await long.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(tabpanel.getByText("3 files changed").count()).resolves.toBe(1);
  // The conversation's files strip lives in Changes.
  await expect(tabpanel.getByRole("heading", { name: "Files", exact: true }).count()).resolves.toBe(1);
  await page.close();
}), 20_000);

browserTest("no_actions_on_ended_session", async () => withBrowser(async browser => {
  const page = await openSession(browser, "ended");
  const actions = page.getByRole("banner").getByRole("group", { name: "Session actions" });
  // Nothing in the title bar would act on a session that has ended; only the frame's details toggle remains.
  await expect(actions.getByRole("button").count()).resolves.toBe(0);
  await expect(page.getByRole("button", { name: "Toggle details panel" }).count()).resolves.toBe(1);
  for (const name of ["End session", "Stop", "Take over", "Resume conversation", "Open in terminal"]) await expect(page.getByRole("button", { name, exact: true }).count()).resolves.toBe(0);
  // The task's title shows in the title bar (the frame hides the route's own heading).
  await expect(page.getByRole("banner").getByRole("heading", { level: 1 }).isVisible()).resolves.toBe(true);
  // The terminal fills the centre without a view switch.
  await expect(page.getByRole("main").getByRole("tablist").count()).resolves.toBe(0);
  // Ended results show their outcome in Details.
  await expect(page.getByRole("complementary", { name: "Session details" }).getByRole("heading", { name: "Result" }).count()).resolves.toBe(1);
  await page.close();
}), 20_000);

browserTest("session_details_toggle_keyboard_and_focus", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation");
  const panel = page.getByRole("complementary", { name: "Session details" });
  const hide = page.getByRole("button", { name: "Toggle details panel" });
  await expect(hide.getAttribute("aria-pressed")).resolves.toBe("true");
  await expect(page.locator("#pc-side-panel-right").count()).resolves.toBe(1);
  // Keyboard activation keeps focus on the persistent title-bar toggle.
  await hide.focus();
  await page.keyboard.press("Enter");
  await expect(panel.count()).resolves.toBe(0);
  await expect(hide.getAttribute("aria-pressed")).resolves.toBe("false");
  await focused(page, '[aria-label="Toggle details panel"]');
  expect(await page.evaluate(() => localStorage.getItem("pacer.panel.session-details"))).toBe("0");
  // Ctrl-Shift-B toggles it from anywhere outside a text field.
  await page.locator("#main-content").focus();
  await page.keyboard.press("Control+Shift+B");
  await panel.waitFor();
  // The panel tabs follow the shared keyboard contract and point at their tabpanel.
  await panel.getByRole("tab", { name: "Details" }).focus();
  await page.keyboard.press("ArrowLeft");
  await focused(page, '[role="tab"][aria-selected="true"]');
  const tab = panel.getByRole("tab", { name: "Changes" });
  await expect(tab.getAttribute("aria-selected")).resolves.toBe("true");
  const controls = await tab.getAttribute("aria-controls");
  await expect(page.locator(`#${controls}`).getAttribute("aria-labelledby")).resolves.toBe(await tab.getAttribute("id"));
  // Ctrl-b collapses the Sessions list and keeps the session usable.
  await page.locator("#main-content").focus();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByRole("complementary", { name: "Sessions" }).count()).resolves.toBe(0);
  await expect(page.getByRole("button", { name: "Show Sessions" }).getAttribute("aria-expanded")).resolves.toBe("false");
  await page.close();
}), 20_000);

browserTest("narrow_session_keeps_details_in_page", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation", { width: 375, height: 812 });
  await expect(page.getByRole("complementary").count()).resolves.toBe(0);
  const details = page.getByRole("region", { name: "Session details" });
  await details.getByRole("tab", { name: "Changes" }).waitFor();
  await expect(page.getByRole("button", { name: "End session" }).isVisible()).resolves.toBe(true);
  // No details toggle without a panel to toggle.
  await expect(page.getByRole("button", { name: /session details/ }).count()).resolves.toBe(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth)).toBe(true);
  await page.close();
}), 20_000);

const callsOf = (page: Page, op: string) => page.evaluate(op => (window as any).CALLS.filter((call: { op: string }) => call.op === op), op);

browserTest("closed_panel_keeps_next_step_reachable", async () => withBrowser(async browser => {
  const page = await openSession(browser, "ended");
  const actions = page.getByRole("banner").getByRole("group", { name: "Session actions" });
  // Open panel: the next step is in the panel, so the title bar offers nothing extra.
  await expect(actions.getByRole("button", { name: "Review result" }).count()).resolves.toBe(0);
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  const next = actions.getByRole("button", { name: "Review result" });
  await expect(next.getAttribute("class")).resolves.toContain("pc-btn--primary");
  // Keyboard activation reopens the panel on Details, where the verdict actions are.
  await next.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary", { name: "Session details" });
  await panel.waitFor();
  await expect(panel.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).resolves.toBe("true");
  await expect(panel.getByRole("button", { name: "Mark accepted" }).isVisible()).resolves.toBe(true);
  await expect(actions.getByRole("button", { name: "Review result" }).count()).resolves.toBe(0);
  // A running session has no next step to surface, even with the panel closed.
  const running = await openSession(browser, "supervised");
  await running.getByRole("button", { name: "Toggle details panel" }).click();
  await expect(running.getByRole("banner").getByRole("button", { name: "Review result" }).count()).resolves.toBe(0);
  await page.close(); await running.close();
}), 30_000);

browserTest("stop_shortcut_confirms_and_only_exists_while_running", async () => withBrowser(async browser => {
  const page = await openSession(browser, "supervised");
  await page.locator("#main-content").focus();
  await page.keyboard.press("s");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await expect(dialog.innerText()).resolves.toContain("Stop this session and its executor?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  expect(await callsOf(page, "task.stop")).toHaveLength(0);
  await page.keyboard.press("s");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Stop" }).click();
  await page.waitForFunction(() => (window as any).CALLS.some((call: { op: string }) => call.op === "task.stop"));
  // Ended: the shortcut is gone with the action (UI-13).
  await page.getByRole("button", { name: "End session" }).waitFor({ state: "detached" });
  await page.locator("#main-content").focus();
  await page.keyboard.press("s");
  await page.waitForTimeout(150);
  await expect(page.getByRole("dialog").count()).resolves.toBe(0);
  await page.close();
}), 30_000);

browserTest("retry_asks_for_an_executor_and_sends_the_current_revision", async () => withBrowser(async browser => {
  const page = await openSession(browser, "ended");
  const panel = page.getByRole("complementary", { name: "Session details" });
  await panel.getByRole("button", { name: "Retry session…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  // The unavailable executor is offered with its reason, never selectable as the default.
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await page.waitForFunction(() => (window as any).CALLS.some((call: { op: string }) => call.op === "task.retry"));
  const [call] = await callsOf(page, "task.retry");
  expect(call.params).toMatchObject({ id: "t-0412", executor: "codex", expect_rev: 3 });
  // Retry opens the new attempt's task.
  await page.waitForFunction(() => location.hash.includes("t-retried"));
  await page.close();
}), 30_000);

browserTest("takeover_starts_from_the_page_and_ended_sessions_offer_none", async () => withBrowser(async browser => {
  const page = await openSession(browser, "supervised");
  const take = page.getByRole("main").getByRole("button", { name: "Take over" });
  await expect(take.isEnabled()).resolves.toBe(true);
  await take.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).CALLS.some((call: { op: string }) => call.op === "task.takeover"));
  expect(await callsOf(page, "task.takeover")).toHaveLength(1);
  await page.close();
  const ended = await openSession(browser, "ended");
  await expect(ended.getByRole("button", { name: "Take over" }).count()).resolves.toBe(0);
  await ended.close();
}), 30_000);

browserTest("ended_conversation_title_bar_does_not_cover_the_search", async () => withBrowser(async browser => {
  for (const width of [1440, 1100, 768, 375]) {
    const page = await openSession(browser, "conversation", { width, height: 900 });
    await page.getByRole("button", { name: "End session" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "End session" }).click();
    const resume = page.getByRole("banner").getByRole("button", { name: "Resume conversation" });
    await resume.waitFor();
    // The actions stay whole and clear of the command search; the title and facts give way instead.
    const box = (selector: string) => page.locator(selector).first().boundingBox();
    const actions = (await resume.boundingBox())!, search = (await page.locator("[data-command-trigger]").boundingBox())!;
    expect(actions.x + actions.width).toBeLessThanOrEqual(search.x + 0.5);
    expect(await resume.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await assertTitleBarFits(page);
    await page.close();
  }
}), 40_000);

async function assertTitleBarFits(page: Page) {
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const title = box("h1.pc-topbar__heading"), search = box("[data-command-trigger]");
    const delegate = [...document.querySelectorAll(".pc-topbar button")].find(node => node.textContent === "Delegate")!.getBoundingClientRect();
    return { scroll: document.scrollingElement!.scrollWidth, width: innerWidth, title: title.width, search: search.width, searchRight: search.right, delegate: delegate.right };
  });
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  expect(geometry.title).toBeGreaterThanOrEqual(80);
  expect(geometry.search).toBeGreaterThan(0);
  expect(geometry.searchRight).toBeLessThanOrEqual(geometry.width);
  expect(geometry.delegate).toBeLessThanOrEqual(geometry.width);
  await expect(page.locator("[data-command-trigger]").isVisible()).resolves.toBe(true);
}

browserTest("session_title_bar_keeps_title_search_and_delegate_reachable", async () => withBrowser(async browser => {
  for (const scenario of ["conversation", "supervised", "ended"] as const) for (const width of [1440, 1100, 768, 375]) {
    const page = await openSession(browser, scenario, { width, height: 900 });
    await assertTitleBarFits(page);
    if (width === 1440) {
      expect(await page.locator("h1.pc-topbar__heading").evaluate(node => {
        const style = getComputedStyle(node);
        return [style.fontSize, style.lineHeight, style.fontWeight];
      })).toEqual(["14px", "20px", "650"]);
      expect(await page.locator(".pc-planner__name").innerText()).toBe("Claude Code");
      expect(await page.locator(".pc-planner__name").evaluate(node => ({ wrap: getComputedStyle(node).whiteSpace, height: node.getBoundingClientRect().height }))).toMatchObject({ wrap: "nowrap", height: 19 });
      expect(await page.locator("h1.pc-topbar__heading").evaluate(node => getComputedStyle(node).textOverflow)).toBe("ellipsis");
      expect(await page.locator(".pc-planner").evaluate(node => node.getBoundingClientRect().height)).toBe(28);
    }
    await page.close();
  }
}), 60_000);

browserTest("session_workspace_fits_between_frame_bars", async () => withBrowser(async browser => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }]) {
    const page = await openSession(browser, "conversation", viewport);
    const geometry = await page.evaluate(() => ({
      scroll: document.scrollingElement!.scrollHeight, height: innerHeight,
      footer: document.querySelector(".pc-conversation-footer")!.getBoundingClientRect().bottom,
      status: document.querySelector(".pc-statusbar")!.getBoundingClientRect().top,
    }));
    expect(geometry.scroll).toBe(geometry.height);
    expect(geometry.footer).toBeLessThanOrEqual(geometry.status);
    await page.close();
  }
}), 30_000);

browserTest("session_status_dot_retains_tone_and_reduced_motion", async () => withBrowser(async browser => {
  for (const scenario of ["supervised", "ended"] as const) {
    const page = await openSession(browser, scenario);
    const dot = page.locator(".pc-session-title-facts .pc-status-dot__dot");
    const expected = await page.evaluate(tone => {
      const node = document.createElement("span"); node.style.color = `var(--${tone}-fg)`; document.body.append(node);
      const color = getComputedStyle(node).color; node.remove(); return color;
    }, scenario === "supervised" ? "info" : "good");
    expect(await dot.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(expected);
    expect(await dot.evaluate(node => getComputedStyle(node).animationName)).toBe(scenario === "supervised" ? "pc-status-pulse" : "none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await dot.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
    await page.close();
  }
}), 30_000);

browserTest("details workspace and brief wrap repository labels without horizontal scroll", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation");
  const panel = page.getByRole("complementary", { name: "Session details" });
  await panel.getByRole("heading", { name: "Workspace", exact: true }).waitFor();
  const captionRepo = page.locator('.pc-session-title-repo[title="Repository"]');
  expect(await captionRepo.innerText()).toBe("acme/api");
  const branch = page.locator('.pc-session-title-branch[title="pacer/review"]');
  expect(await branch.innerText()).toBe("pacer/review");
  expect(await branch.locator("svg").count()).toBe(1);
  expect(await branch.locator("span").evaluate(node => getComputedStyle(node).textOverflow)).toBe("ellipsis");
  expect(await captionRepo.evaluate(node => getComputedStyle(node).fontFamily)).toContain("mono");
  const repo = panel.locator(".pc-session-workspace dd").first();
  expect(await repo.innerText()).toBe("acme/api");
  const briefRepo = panel.locator(".pc-session-repository");
  expect(await briefRepo.innerText()).toBe("acme/api");
  for (const value of [repo, briefRepo]) {
    expect(await value.evaluate(node => getComputedStyle(node).overflowWrap)).toBe("anywhere");
    // Exercise an unbroken repository label wider than the panel without changing fixture data.
    expect(await value.evaluate(node => { node.textContent = "repository/".repeat(40); return node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().height > 18; })).toBe(true);
  }
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const sections = await panel.locator(".pc-session-details section").evaluateAll(nodes => nodes.map(node => ({ title: node.querySelector("h3")?.textContent, border: getComputedStyle(node).borderTopWidth, padding: getComputedStyle(node).paddingTop })));
  expect(sections[0]).toMatchObject({ title: "Workspace", border: "0px", padding: "0px" });
  for (const section of sections.slice(1)) expect(section).toMatchObject({ border: "1px", padding: "14px" });
  const command = panel.locator(".pc-session-command code");
  expect(await command.evaluate(node => ({ font: getComputedStyle(node).fontSize, padding: getComputedStyle(node).padding, radius: getComputedStyle(node).borderRadius }))).toEqual({ font: "12px", padding: "6px 8px", radius: "6px" });
  await page.close();
}), 20_000);


browserTest("sessions navigator matches board geometry and retains panel focus", async () => withBrowser(async browser => {
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await openSession(browser, "conversation", { width: 1440, height: 900 }, colorScheme);
    const panel = page.getByRole("complementary", { name: "Sessions", exact: true });
    const hide = panel.getByRole("button", { name: "Hide Sessions" });
    const geometry = await panel.evaluate(node => {
      const nav = node.querySelector(".pc-task-nav")!, head = node.querySelector(".pc-task-nav__head")!;
      const card = node.querySelector(".pc-task-card")!, scroll = node.querySelector(".pc-task-nav__scroll")!;
      return { width: node.getBoundingClientRect().width, cardX: card.getBoundingClientRect().x, cardWidth: card.getBoundingClientRect().width,
        headTop: head.getBoundingClientRect().top, headHeight: head.getBoundingClientRect().height, headPadding: getComputedStyle(head).padding,
        listPadding: getComputedStyle(scroll).padding, navBorder: getComputedStyle(nav).borderRightWidth,
        barCount: node.querySelectorAll(".pc-side-panel__bar").length,
        toggleInHead: !!head.querySelector('[aria-label="Hide Sessions"]') };
    });
    expect(geometry).toEqual({ width: 272, cardX: 60, cardWidth: 256, headTop: 44, headHeight: 38, headPadding: "0px 8px 0px 14px",
      listPadding: "0px 8px 12px", navBorder: "0px", barCount: 0, toggleInHead: true });
    await expect(hide.getAttribute("aria-expanded")).resolves.toBe("true");
    await expect(hide.getAttribute("aria-controls")).resolves.toBe("pc-side-panel-left");
    await expect(panel.locator('.pc-task-card__branch--repo').first().getAttribute("title")).resolves.toBe("Repository");
    const selected = panel.locator('.pc-task-card__main--selected');
    expect(await selected.locator('.pc-task-card__title').evaluate(node => getComputedStyle(node).fontWeight)).toBe("650");
    expect(await selected.evaluate(node => (() => { const sample = document.createElement("span"); sample.style.background = "var(--surface-page)"; node.append(sample); const matches = getComputedStyle(node).backgroundColor === getComputedStyle(sample).backgroundColor; sample.remove(); return matches; })())).toBe(true);
    await hide.focus(); await page.keyboard.press("Enter");
    await focused(page, '[aria-label="Show Sessions"]');
    const show = page.getByRole("button", { name: "Show Sessions" });
    await expect(show.getAttribute("aria-expanded")).resolves.toBe("false");
    await expect(show.getAttribute("aria-controls")).resolves.toBe(null);
    expect(await page.locator('.pc-side-panel--left').evaluate(node => node.getBoundingClientRect().width)).toBe(40);
    await page.keyboard.press("Enter");
    await focused(page, '[aria-label="Hide Sessions"]');
    // Collapsing while a row has focus moves focus into the retained closed strip.
    await panel.locator('[aria-current="page"]').focus();
    await page.keyboard.press("ControlOrMeta+b");
    await focused(page, '[aria-label="Show Sessions"]');
    await page.keyboard.press("Enter");
    await focused(page, '[aria-label="Hide Sessions"]');
    // The persistent frame control continues to work and keeps focus.
    const frameToggle = page.getByRole("button", { name: "Toggle left panel" });
    await frameToggle.click();
    await expect(panel.count()).resolves.toBe(0);
    await focused(page, '[aria-label="Toggle left panel"]');
    await frameToggle.click();
    await panel.waitFor();
    await page.close();
  }
}), 30_000);
