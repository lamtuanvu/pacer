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
  await page.locator(".pc-session-title-actions").first().waitFor();
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
    const actions = page.getByRole("banner").getByRole("group", { name: "Session actions" });
    const end = actions.getByRole("button", { name: "End session" });
    await expect(end.getAttribute("class")).resolves.toContain("pc-btn--danger");
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
    // Once ended, End session leaves the title bar and focus stays in its group, on the details toggle.
    await end.waitFor({ state: "detached" });
    await focused(page, '[aria-label="Hide session details"]');
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
  // Only the details toggle remains: nothing that would act on a session that has ended.
  expect(await actions.getByRole("button").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")))).toEqual(["Hide session details"]);
  for (const name of ["End session", "Stop", "Take over", "Resume conversation", "Open in terminal"]) await expect(page.getByRole("button", { name, exact: true }).count()).resolves.toBe(0);
  // The terminal fills the centre without a view switch.
  await expect(page.getByRole("main").getByRole("tablist").count()).resolves.toBe(0);
  // Ended results show their outcome in Details.
  await expect(page.getByRole("complementary", { name: "Session details" }).getByRole("heading", { name: "Result" }).count()).resolves.toBe(1);
  await page.close();
}), 20_000);

browserTest("session_details_toggle_keyboard_and_focus", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation");
  const panel = page.getByRole("complementary", { name: "Session details" });
  const hide = page.getByRole("button", { name: "Hide session details" });
  await expect(hide.getAttribute("aria-expanded")).resolves.toBe("true");
  await expect(hide.getAttribute("aria-controls")).resolves.toBe("pc-side-panel-right");
  await expect(page.locator("#pc-side-panel-right").count()).resolves.toBe(1);
  // Keyboard activation keeps focus on the persistent title-bar toggle.
  await hide.focus();
  await page.keyboard.press("Enter");
  await expect(panel.count()).resolves.toBe(0);
  const show = page.getByRole("button", { name: "Show session details" });
  await expect(show.getAttribute("aria-expanded")).resolves.toBe("false");
  await focused(page, '[aria-label="Show session details"]');
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
  // Ctrl-b collapses the Tasks list and keeps the session usable.
  await page.locator("#main-content").focus();
  await page.keyboard.press("Control+b");
  await expect(page.getByRole("complementary", { name: "Tasks" }).count()).resolves.toBe(0);
  await expect(page.getByRole("button", { name: "Show Tasks" }).getAttribute("aria-expanded")).resolves.toBe("false");
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
  await page.getByRole("button", { name: "Hide session details" }).click();
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
  await running.getByRole("button", { name: "Hide session details" }).click();
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
