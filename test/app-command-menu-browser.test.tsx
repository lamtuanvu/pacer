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
  await open(page, built, "#/");
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
  await open(page, built, "#/");
  const opener = page.getByRole("button", { name: /Search tasks/ });
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("combobox").waitFor();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await focused(page, ".pc-command-trigger");
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
  await expect(page.getByRole("tablist", { name: "Search in" }).count()).resolves.toBe(0);
  const options = await labels(page);
  expect(options).toContain("Toggle left panel");
  expect(options).not.toContain("Add SSH keepalive to remote runs");
  // The shortcut shows as key caps next to the command.
  // macOS draws the modifier as a symbol (⌘ B there), other platforms as Ctrl B.
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await expect(page.locator('[role="option"]', { hasText: "Toggle left panel" }).locator(".pc-command__keys kbd").allTextContents()).resolves.toEqual([mac ? "⌘" : "Ctrl", "B"]);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Show Settings" }).waitFor();
  // Back to a bare query: recents with the Go to commands.
  await page.keyboard.press("Control+k");
  await expect(page.locator(".pc-command__group").first().getAttribute("aria-labelledby")).resolves.toBeTruthy();
  expect((await page.locator(".pc-command__heading").allTextContents())[0]).toBe("Recent");
}));

browserTest("tab_cycles_scopes_and_empty_state_offers_new_task", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("a");
  const tabs = page.getByRole("tablist", { name: "Search in" }).getByRole("tab");
  await expect(tabs.allTextContents()).resolves.toEqual([expect.stringMatching(/^All \d+$/), expect.stringMatching(/^Tasks \d+$/), expect.stringMatching(/^Agents \d+$/), expect.stringMatching(/^Files( \d+)?$/), expect.stringMatching(/^Commands \d+$/)]);
  // The Tab hint sits beside the tablist, not inside it.
  await expect(page.locator('[role="tablist"] .pc-command__hint').count()).resolves.toBe(0);
  // The tabs control the results listbox.
  await expect(tabs.first().getAttribute("aria-controls")).resolves.toBe(await page.getByRole("combobox").getAttribute("aria-controls"));
  const pressed = () => page.locator('.pc-command__scope[aria-selected="true"]').textContent();
  await expect(pressed()).resolves.toMatch(/^All/);
  await page.keyboard.press("Tab");
  await expect(pressed()).resolves.toMatch(/^Tasks/);
  expect(await page.locator(".pc-command__heading").allTextContents()).toEqual(["Tasks"]);
  await focused(page, 'input[role="combobox"]');
  await page.keyboard.press("Shift+Tab");
  await expect(pressed()).resolves.toMatch(/^All/);
  // A scope with no matches falls back to All instead of showing an empty list.
  await page.getByRole("tab", { name: /^Agents/ }).click();
  await expect(pressed()).resolves.toMatch(/^Agents/);
  await input.fill("keepalive");
  expect(await labels(page)).toEqual(["Add SSH keepalive to remote runs"]);
  await expect(pressed()).resolves.toMatch(/^All/);
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
  await open(page, built, "#/");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("combobox").waitFor();
  const box = await page.locator("dialog.pc-command").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth)).toBe(true);
}, { width: 375, height: 700 }));

browserTest("enter_while_composing_does_not_pick", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("fix");
  // An IME candidate confirmation arrives as Enter with isComposing set.
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await expect(page.getByRole("combobox").count()).resolves.toBe(1);
  expect(await page.evaluate(() => location.hash)).toBe("#/");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
}));

browserTest("shift_ctrl_k_and_clicks", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+Shift+K");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill(">count");
  // A mouse pick runs the command and closes the menu.
  await page.getByRole("option", { name: /^Count one/ }).click();
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await page.waitForFunction(() => (window as any).counted === 1);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("devbox");
  await page.getByRole("option", { name: /devbox/ }).first().click();
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
}));

browserTest("a new query puts the highlight back on the first result", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("a");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  expect((await activeOption(page)).label).toBe((await labels(page))[2]);
  await input.fill("ab");
  await page.waitForTimeout(150);
  const after = await labels(page);
  if (after.length) expect((await activeOption(page)).label).toBe(after[0]);
  await input.fill("fix");
  await page.waitForTimeout(150);
  expect((await activeOption(page)).label).toBe((await labels(page))[0]);
}));

browserTest("escape_returns_focus_to_the_trigger_when_a_click_does_not_focus_it", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  // WebKit (Safari, the desktop shell) leaves focus on the body when a button is clicked; stopping mousedown does the same here.
  await page.evaluate(() => document.querySelector(".pc-command-trigger")!.addEventListener("mousedown", event => event.preventDefault()));
  await page.locator(".pc-command-trigger").click();
  await page.getByRole("combobox").waitFor();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await focused(page, ".pc-command-trigger");
  // Cmd-K with nothing focused also lands on the trigger.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").waitFor();
  await page.keyboard.press("Escape");
  await focused(page, ".pc-command-trigger");
}));

browserTest("mod_enter_runs_a_command_and_keeps_the_menu_open", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  // Outside commands mode ⌘↵ "open beside" is announced as coming soon and does nothing.
  const footer = await page.locator(".pc-command__footer").textContent();
  expect(footer).toContain("open beside");
  expect(footer).toContain("Coming soon");
  expect(footer).not.toContain("keep open");
  await input.fill("fix");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("combobox").count()).resolves.toBe(1);
  expect(await page.evaluate(() => location.hash)).toBe("#/");
  await input.fill(">count");
  await expect(page.locator(".pc-command__footer").textContent()).resolves.toContain("run and keep open");
  await expect(page.locator(".pc-command__footer").textContent()).resolves.not.toContain("Coming soon");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => (window as any).counted === 1);
  await expect(page.getByRole("combobox").count()).resolves.toBe(1);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => (window as any).counted === 2);
  // Plain Enter runs it and closes the menu.
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).counted === 3);
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
}));

browserTest("mod_enter_closes_the_menu_for_a_command_that_opens_a_dialog", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill(">shortcuts");
  await page.getByRole("option", { name: /^Show keyboard shortcuts/ }).waitFor();
  expect(await labels(page)).toEqual(["Show keyboard shortcuts"]);
  // The shortcuts overlay is a dialog of its own, which a modal menu would leave inert, so ⌘↵ closes the menu like Enter does.
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => (window as any).helped === 1);
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  // Focus goes back to what had it when the menu opened (the page's main area).
  await focused(page, "#main-content");
}));

browserTest("dispatcher_commands_follow_the_service_operations", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill(">dispatch");
  // Pause is offered because the service has delegation.pause; resume and the saved-setup switch are not (no such operations here).
  expect(await labels(page)).toEqual(["Pause dispatch", "Budget & pacing"]);
  // The Commands chip stays, so later queries are the text after it.
  await input.fill("saved setup");
  await expect(page.getByRole("option").count()).resolves.toBe(0);
  await input.fill("budget");
  expect(await labels(page)).toEqual(["Budget & pacing"]);
  await input.fill("pause");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await page.waitForFunction(() => JSON.stringify((window as any).dispatchCalls) === JSON.stringify([["pause", { for: "1h" }]]));
  // Budget & pacing opens the planner settings.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill(">budget");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash === "#/settings/planner");
}));

browserTest("menu_and_trigger_match_the_board_measurements", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  const trigger = page.locator(".pc-command-trigger");
  const t = await trigger.evaluate(element => { const r = element.getBoundingClientRect(), css = getComputedStyle(element); return { w: Math.round(r.width), h: Math.round(r.height), radius: css.borderTopLeftRadius, border: css.borderTopWidth, padL: css.paddingLeft, caps: element.querySelectorAll("kbd").length, text: element.querySelector(".pc-command-trigger__text")!.textContent }; });
  expect(t).toMatchObject({ w: 420, h: 30, radius: "8px", border: "1px", padL: "10px", caps: 1, text: "Search tasks, agents or run a command" });
  await trigger.click();
  await page.getByRole("combobox").fill("fix");
  await page.waitForTimeout(100);
  const m = await page.evaluate(() => {
    const css = (selector: string) => getComputedStyle(document.querySelector(selector)!), box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { dialogW: Math.round(box("dialog.pc-command").width), dialogTop: Math.round(box("dialog.pc-command").top), dialogRadius: css("dialog.pc-command").borderTopLeftRadius, rowH: Math.round(box(".pc-command__search").height), inputOutline: css(".pc-command__input").outlineStyle, focusRing: css(".pc-command__search").boxShadow.includes("inset") ? "inset" : css(".pc-command__search").boxShadow,
      optionRadius: css(".pc-command__option").borderTopLeftRadius, glyph: [Math.round(box(".pc-command__glyph").width), css(".pc-command__glyph").borderTopLeftRadius], markWeight: css(".pc-command__label mark").fontWeight,
      scopeH: Math.round(box(".pc-command__scope").height), scopeRadius: css(".pc-command__scope").borderTopLeftRadius, kbd: [css(".pc-command__footer kbd").borderTopLeftRadius, css(".pc-command__footer kbd").fontSize, Math.round(box(".pc-command__footer kbd").height)],
      placeholder: document.querySelector<HTMLInputElement>('input[role="combobox"]')!.placeholder, label: document.querySelector('input[role="combobox"]')!.getAttribute("aria-label") };
  });
  expect(m).toMatchObject({ dialogW: 640, dialogTop: 72, dialogRadius: "14px", rowH: 52, inputOutline: "none", focusRing: "inset", optionRadius: "8px", glyph: [28, "7px"], markWeight: "700", scopeH: 24, scopeRadius: "6px", kbd: ["4px", "11px", 18],
    placeholder: "Search tasks, agents, files or type > for commands", label: "Search tasks, agents, files or run a command" });
}));

browserTest("the commands chip replaces the leading greater-than and backspace removes it", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill(">pa");
  // The chip carries the mode; the input shows only what follows it.
  await expect(page.locator(".pc-command__prefix").textContent()).resolves.toBe("Commands");
  await expect(input.inputValue()).resolves.toBe("pa");
  const headings = await page.locator(".pc-command__heading").allTextContents();
  expect(headings).not.toContain("Suggested");
  await input.fill("");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".pc-command__prefix").count()).resolves.toBe(0);
  await expect(input.inputValue()).resolves.toBe("");
  // Back to the recent screen.
  expect((await page.locator(".pc-command__heading").allTextContents())[0]).toBe("Recent");
  // Typing > again re-enters command mode.
  await input.fill(">");
  await expect(page.locator(".pc-command__prefix").count()).resolves.toBe(1);
}));

browserTest("select_all_works_in_the_input", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("fix");
  // Cmd+A on macOS, Ctrl+A elsewhere: the menu selects the text itself, so it does not depend on the host's Edit menu.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("x");
  await expect(input.inputValue()).resolves.toBe("x");
}));

const filesAnswer = (page: Page, answer: object) => page.evaluate(value => { (window as any).filesAnswer = value; (window as any).fileCalls = []; }, answer);

browserTest("files_search_is_debounced_and_results_show_ranges_repo_and_changed_by_subtitle", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await filesAnswer(page, { results: [
    { repo: "github.com/acme/api", repoLabel: "acme/api", path: "src/ssh/keepalive.ts", ranges: [[4, 7]], changedBy: [{ task: "t-0420", title: "Add SSH keepalive" }] },
    { repo: "github.com/acme/api", repoLabel: "acme/api", path: "docs/ssh.md", ranges: [[5, 8]] },
  ] });
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.waitFor();
  // With files searchable the input says so; the title-bar trigger keeps its own wording.
  await expect(input.getAttribute("placeholder")).resolves.toBe("Search tasks, agents, files or type > for commands");
  await expect(input.getAttribute("aria-label")).resolves.toBe("Search tasks, agents, files or run a command");
  // Typing quickly starts one search, after the debounce (the three edits land in one tick, so a slow machine cannot split them).
  await page.evaluate(() => { const el = document.querySelector<HTMLInputElement>('input[role="combobox"]')!; for (const value of ["s", "ss", "ssh"]) { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); } });
  expect(await page.evaluate(() => (window as any).fileCalls)).toEqual([]);
  await page.getByRole("option", { name: /keepalive\.ts/ }).waitFor();
  expect(await page.evaluate(() => (window as any).fileCalls)).toEqual([{ query: "ssh", limit: 20 }]);
  const tabs = await page.getByRole("tablist", { name: "Search in" }).getByRole("tab").allTextContents();
  expect(tabs.map(tab => tab.replace(/\s*\d+$/, ""))).toEqual(["All", "Tasks", "Agents", "Files", "Commands"]);
  const filesTab = page.getByRole("tab", { name: /^Files/ });
  await expect(filesTab.textContent()).resolves.toMatch(/^Files 2$/);
  // The match is marked within the path; the repo, the task chip and the reason are plain words.
  const first = page.getByRole("option", { name: /keepalive\.ts/ });
  await expect(first.locator("mark").allTextContents()).resolves.toContain("ssh");
  await expect(first.locator(".pc-command__sub").textContent()).resolves.toBe("acme/api · changed by “Add SSH keepalive”");
  // The board has no pill on file rows: the running-task case is the subtitle alone.
  await expect(first.locator(".pc-pill").count()).resolves.toBe(0);
  // The Files tab lists only files.
  await filesTab.click();
  expect(await page.locator(".pc-command__heading").allTextContents()).toEqual(["Files"]);
  // A file a running task changed opens that task.
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => location.hash)).toBe("#/tasks/t-0420");
  await expect(input.count()).resolves.toBe(0);
}));

browserTest("a file no running task changed copies its path on Enter and says so", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copied = text; } } }); });
  await filesAnswer(page, { results: [{ repo: "github.com/acme/api", repoLabel: "acme/api", path: "docs/ssh.md", ranges: [[5, 8]] }] });
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("ssh");
  const row = page.getByRole("option", { name: /docs\/ssh\.md/ });
  await row.waitFor();
  await row.hover();
  // The footer names the action, and nothing offers a viewer that does not exist.
  const footer = await page.locator(".pc-command__footer").textContent();
  expect(footer).toContain("copy path");
  expect(footer).not.toMatch(/viewer/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  expect(await page.evaluate(() => (window as any).copied)).toBe("docs/ssh.md");
  expect(await page.evaluate(() => location.hash)).toBe("#/");
  await page.waitForFunction(() => document.querySelector(".pc-toasts")?.textContent?.includes("Path copied"));
}));

browserTest("a failed copy says so", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); document.execCommand = () => false; });
  await filesAnswer(page, { results: [{ repo: "github.com/acme/api", repoLabel: "acme/api", path: "docs/ssh.md", ranges: [[5, 8]] }] });
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("ssh");
  await page.getByRole("option", { name: /docs\/ssh\.md/ }).hover();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".pc-toasts")?.textContent?.includes("Could not copy the path"));
}));

browserTest("repositories that could not be searched are named with a reason and an error is explained", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await filesAnswer(page, { truncated: true, repos: [{ key: "github.com/acme/web", state: "too_large" }, { key: "github.com/lamtuanvu/pacer", state: "timeout" }],
    results: [{ repo: "github.com/acme/api", repoLabel: "acme/api", path: "src/ssh.ts", ranges: [[4, 7]] }] });
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("ssh");
  const notice = page.locator(".pc-command__notice");
  await page.waitForFunction(() => document.querySelector(".pc-command__notice")?.textContent?.includes("acme/web"));
  const text = await notice.textContent();
  expect(text).toContain("acme/web has too many files to search");
  expect(text).toContain("pacer took too long to read");
  expect(text).toContain("Showing the first matches");
  expect(text).not.toMatch(/too_large|timeout/);
  // A failed search says so instead of showing nothing.
  await page.evaluate(() => { (window as any).failFiles = true; });
  await page.getByRole("combobox").fill("sshx");
  await page.waitForFunction(() => document.querySelector(".pc-command__notice")?.textContent === "Files could not be searched just now.");
  // Searching again shows the loading line first and never 'no results' while it waits.
  await page.evaluate(() => { (window as any).failFiles = false; (window as any).filesAnswer = { results: [] }; });
  await page.getByRole("combobox").fill("zzz");
  await page.waitForFunction(() => document.querySelector(".pc-command__empty")?.textContent?.includes("Nothing matches"));
}));

browserTest("a webview that refuses the clipboard API still copies through the fallback", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    document.execCommand = (name: string) => { (window as any).copiedBy = [name, window.getSelection()?.toString() ?? null]; return true; };
  });
  await filesAnswer(page, { results: [{ repo: "github.com/acme/api", repoLabel: "acme/api", path: "docs/ssh.md", ranges: [[5, 8]] }] });
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("ssh");
  await page.getByRole("option", { name: /docs\/ssh\.md/ }).hover();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".pc-toasts")?.textContent?.includes("Path copied"));
  expect(await page.evaluate(() => (window as any).copiedBy)).toEqual(["copy", "docs/ssh.md"]);
  // The hidden element is removed again.
  expect(await page.locator("body > span.sr-only").count()).toBe(0);
}));

browserTest("results arrive in a polite live region and an empty Files answer falls back to All", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await filesAnswer(page, { results: [] });
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("fix");
  // Tasks match; the empty Files answer must not leave the Files tab selected with the tasks hidden.
  await page.getByRole("tab", { name: /^Files 0/ }).waitFor();
  await page.getByRole("tab", { name: /^Files/ }).click();
  await expect(page.locator('.pc-command__scope[aria-selected="true"]').textContent()).resolves.toMatch(/^All/);
  const live = page.locator('.sr-only[role="status"]');
  await expect(live.textContent()).resolves.toMatch(/^\d+ results?/);
  // The combobox is described by the footer hint (what Enter does).
  const described = await input.getAttribute("aria-describedby");
  expect(await page.evaluate(id => document.getElementById(id!.split(" ").at(-1)!)?.textContent, described)).toContain("open");
}));

browserTest("tray new-task deep link opens Delegate and consumes only its query parameter", () => withPage(async (page) => {
  const build = await Bun.build({ entrypoints: ["app/src/main.tsx"], target: "browser", splitting: false, plugins: [{
    name: "main-service-fixture", setup(builder) {
      builder.onResolve({ filter: /data\/control$/ }, args => args.importer.endsWith("/main.tsx") ? {path:"control",namespace:"main-fixture"}:undefined);
      builder.onResolve({ filter: /data\/navigation-guard$/ }, args => args.importer.endsWith("/main.tsx") ? {path:"guard",namespace:"main-fixture"}:undefined);
      builder.onResolve({ filter: /data\/store$/ }, args => args.importer.endsWith("/main.tsx") ? { path: "store", namespace: "main-fixture" } : undefined);
      builder.onResolve({ filter: /data\/api$/ }, args => args.importer.endsWith("/main.tsx") ? { path: "api", namespace: "main-fixture" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "main-fixture" }, args => ({ loader: "js", resolveDir: process.cwd(), contents: args.path === "control" ? `export const startClientControl = (api,surface,navigate) => {window.controlNavigate=navigate;return ()=>{};};` : args.path === "guard" ? `export const canLeaveScreen = async () => window.allowLeave !== false;` : args.path === "store" ? `
        import { initialState } from "./app/src/data/store.ts";
        import snapshot from "./test/fixtures/ui/snapshot.json";
        export const createStore = () => {
          const state = {...initialState(), connected:true, snapshot, features:{readModel:true,ops:new Set(["task.delegate"])}};
          return {getState:()=>state,subscribe:()=>()=>{},start:()=>()=>{},refresh:async()=>{}};
        };
      ` : `
        export const createApi = () => ({call:async op => op === "setup.check" ? {complete:true,ready:true,items:[],checkedAt:1} : op === "routing.route" ? {ranked:[],excluded:[]} : [],hello:async()=>({ops:[]}),snapshot:async()=>({})});
      ` }));
    }
  }] });
  expect(build.success).toBe(true);
  await open(page, { source: await build.outputs[0]!.text(), css: "" }, "#/?new=task&scope=all");
  await page.getByRole("dialog", { name: "Delegate a task" }).waitFor();
  expect(await page.evaluate(() => location.hash)).toBe("#/?scope=all");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.evaluate(() => { location.hash = "#/?a=1&&new=task"; });
  await page.getByRole("dialog", { name: "Delegate a task" }).waitFor();
  expect(await page.evaluate(() => location.hash)).toBe("#/?a=1");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  expect(await page.evaluate(() => (window as any).controlNavigate("/?new=task"))).toBe(true);
  await page.getByRole("dialog", { name: "Delegate a task" }).waitFor();
  expect(await page.evaluate(() => location.hash)).toBe("#/");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.evaluate(()=>{(window as any).allowLeave=false;});
  expect(await page.evaluate(() => (window as any).controlNavigate("/?new=task"))).toBe(false);
  expect(await page.getByRole("dialog", {name:"Delegate a task"}).count()).toBe(0);
  expect(await page.evaluate(() => location.hash)).toBe("#/");
  await page.evaluate(()=>{ location.hash="#/settings?new=task"; });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => location.hash)).toBe("#/");
  expect(await page.getByRole("dialog", {name:"Delegate a task"}).count()).toBe(0);
  await page.evaluate(()=>{(window as any).allowLeave=true; location.hash="#/settings?new=task";});
  await page.getByRole("dialog", { name: "Delegate a task" }).waitFor();
  expect(await page.evaluate(() => location.hash)).toBe("#/settings");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.evaluate(()=>{location.hash="#/x?new=task&q=a?b";});
  await page.getByRole("dialog", { name: "Delegate a task" }).waitFor();
  expect(await page.evaluate(() => location.hash)).toBe("#/x?q=a?b");
}));
