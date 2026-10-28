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
  await page.route("http://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>frame</title><div id="app"></div>' }));
  await page.goto(`http://pacer.test/${hash}`);
  await page.evaluate(css => { document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`); }, built.css);
  await page.evaluate(async code => { const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })); await import(url); URL.revokeObjectURL(url); }, built.source);
  await page.locator("#main-content").waitFor();
}
const focused = (page: Page, selector: string) => page.waitForFunction(at => document.activeElement?.matches(at), selector, { timeout: 2000 });
async function withPage(run: (page: Page, built: Awaited<ReturnType<typeof frame>>) => Promise<void>, viewport = { width: 1440, height: 900 }) {
  const built = await frame();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try { await run(await browser.newPage({ viewport }), built); } finally { await browser.close(); }
}
const activeOption = (page: Page) => page.evaluate(() => {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const option = document.getElementById(input.getAttribute("aria-activedescendant") ?? "");
  return { label: option?.querySelector(".pc-command__label")?.textContent ?? null, selected: option?.getAttribute("aria-selected") ?? null, role: option?.getAttribute("role") ?? null };
});
const labels = (page: Page) => page.locator('[role="option"] .pc-command__label').allTextContents();

browserTest("combobox_aria_and_arrow_home_end_enter", () => withPage(async (page, built) => {
  await open(page, built, "#/overview");
  await page.getByRole("button", { name: /Search tasks/ }).click();
  const input = page.getByRole("combobox");
  await input.waitFor();
  await focused(page, 'input[role="combobox"]');
  await expect(input.getAttribute("aria-expanded")).resolves.toBe("true");
  const listId = await input.getAttribute("aria-controls");
  await expect(page.locator(`[id="${listId}"]`).getAttribute("role")).resolves.toBe("listbox");
  const first = await activeOption(page);
  expect(first).toMatchObject({ role: "option", selected: "true" });
  const all = await labels(page);
  await page.keyboard.press("ArrowDown");
  expect((await activeOption(page)).label).toBe(all[1]);
  await page.keyboard.press("End");
  expect((await activeOption(page)).label).toBe(all[all.length - 1]);
  await page.keyboard.press("ArrowDown");
  expect((await activeOption(page)).label).toBe(all[0]);
  await page.keyboard.press("ArrowUp");
  expect((await activeOption(page)).label).toBe(all[all.length - 1]);
  await page.keyboard.press("Home");
  expect((await activeOption(page)).label).toBe(all[0]);
  // Only the active option is selected, and focus never leaves the input.
  await expect(page.locator('[role="option"][aria-selected="true"]').count()).resolves.toBe(1);
  await focused(page, 'input[role="combobox"]');
  // Typing narrows the list and marks the match; Enter opens the task and closes the menu.
  await input.fill("keepalive");
  await expect(labels(page)).resolves.toEqual(["Add SSH keepalive to remote runs"]);
  await expect(page.locator(".pc-command__label mark").allTextContents()).resolves.toEqual(["keepalive"]);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  expect(await page.evaluate(() => location.hash)).toBe("#/tasks/t-0420");
}));

browserTest("escape_returns_focus_to_the_opener", () => withPage(async (page, built) => {
  await open(page, built, "#/overview");
  const opener = page.getByRole("button", { name: /Search tasks/ });
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("combobox").waitFor();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await focused(page, ".pc-topbar__search");
  // Cmd-K and Ctrl-K open it from anywhere and a second press closes it; focus goes back to where it was.
  await page.locator("#main-content").focus();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").waitFor();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await focused(page, "#main-content");
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").waitFor();
  await page.mouse.click(5, 5);
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await focused(page, "#main-content");
}));

browserTest("greater_than_switches_to_commands_and_runs_one", () => withPage(async (page, built) => {
  await open(page, built, "#/settings");
  const hide = page.getByRole("button", { name: "Hide Settings" });
  await hide.waitFor();
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill(">panel");
  await expect(page.locator(".pc-command__prefix").textContent()).resolves.toBe("Commands");
  await expect(page.getByRole("group", { name: "Search in" }).count()).resolves.toBe(0);
  const options = await labels(page);
  expect(options).toContain("Toggle side panel");
  expect(options).not.toContain("Add SSH keepalive to remote runs");
  // The shortcut shows as key caps next to the command.
  await expect(page.locator('[role="option"]', { hasText: "Toggle side panel" }).locator(".pc-command__keys kbd").allTextContents()).resolves.toEqual(["Ctrl", "B"]);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Show Settings" }).waitFor();
  // Back to a bare query: recents with the Go to commands.
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("group").first().getAttribute("aria-labelledby")).resolves.toBeTruthy();
  expect((await page.locator(".pc-command__heading").allTextContents())[0]).toBe("Recent");
}));

browserTest("tab_cycles_scopes_and_empty_state_offers_new_task", () => withPage(async (page, built) => {
  await open(page, built, "#/overview");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("a");
  const tabs = page.getByRole("group", { name: "Search in" }).getByRole("button");
  await expect(tabs.allTextContents()).resolves.toEqual(expect.arrayContaining([expect.stringMatching(/^All \d+$/), expect.stringMatching(/^Tasks \d+$/)]));
  const pressed = () => page.locator('.pc-command__scope[aria-pressed="true"]').textContent();
  await expect(pressed()).resolves.toMatch(/^All/);
  await page.keyboard.press("Tab");
  await expect(pressed()).resolves.toMatch(/^Tasks/);
  expect(await page.locator(".pc-command__heading").allTextContents()).toEqual(["Tasks"]);
  await focused(page, 'input[role="combobox"]');
  await page.keyboard.press("Shift+Tab");
  await expect(pressed()).resolves.toMatch(/^All/);
  // A scope with no matches falls back to All instead of showing an empty list.
  await page.getByRole("button", { name: /^Machines/ }).click();
  await expect(pressed()).resolves.toMatch(/^Machines/);
  await input.fill("keepalive");
  expect(await labels(page)).toEqual(["Add SSH keepalive to remote runs"]);
  // Nothing matches: say so, offer New task, and let Enter run it.
  await input.fill("xyzzy plugin");
  await expect(page.getByRole("status").filter({ hasText: "Nothing matches" }).textContent()).resolves.toContain("xyzzy plugin");
  await expect(labels(page)).resolves.toEqual(["New task", "Browse all tasks"]);
  // The aria-activedescendant still points at the first fallback.
  expect((await activeOption(page)).label).toBe("New task");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await page.waitForFunction(() => (window as any).newTask === 1);
  // ? is plain text until the assistant exists.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("?why");
  await expect(page.locator(".pc-command__prefix").count()).resolves.toBe(0);
}));

browserTest("menu_fits_a_375px_screen", () => withPage(async (page, built) => {
  await open(page, built, "#/overview");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("combobox").waitFor();
  const box = await page.locator("dialog.pc-command").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth)).toBe(true);
}, { width: 375, height: 700 }));

browserTest("enter_while_composing_does_not_pick", () => withPage(async (page, built) => {
  await open(page, built, "#/overview");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("fix");
  // An IME candidate confirmation arrives as Enter with isComposing set.
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await expect(page.getByRole("combobox").count()).resolves.toBe(1);
  expect(await page.evaluate(() => location.hash)).toBe("#/overview");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
}));

browserTest("shift_ctrl_k_and_clicks", () => withPage(async (page, built) => {
  await open(page, built, "#/overview");
  await page.keyboard.press("Control+Shift+K");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill(">");
  // A mouse pick runs the command and closes the menu.
  await page.getByRole("option", { name: /^New task/ }).click();
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await page.waitForFunction(() => (window as any).newTask === 1);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("devbox");
  await page.getByRole("option", { name: /devbox/ }).first().click();
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
}));
