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
  const hide = page.getByRole("button", { name: "Toggle left panel" });
  await hide.waitFor();
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill(">panel");
  await expect(page.locator(".pc-command__prefix").textContent()).resolves.toBe("Commands");
  await expect(page.getByRole("tablist", { name: "Search in" }).count()).resolves.toBe(1);
  const options = await labels(page);
  expect(options).toContain("Toggle left panel");
  expect(options).not.toContain("Add SSH keepalive to remote runs");
  // The shortcut shows as key caps next to the command.
  // macOS draws the modifier as a symbol (⌘ B there), other platforms as Ctrl B.
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await expect(page.locator('[role="option"]', { hasText: "Toggle left panel" }).locator(".pc-command__keys kbd").allTextContents()).resolves.toEqual([mac ? "⌘" : "Ctrl", "B"]);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Toggle left panel" }).waitFor();
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
  // Tabs control the named panel; the combobox continues to control its results listbox.
  await expect(tabs.first().getAttribute("aria-controls")).resolves.toBe(await page.getByRole("tabpanel").getAttribute("id"));
  await expect(page.getByRole("combobox").getAttribute("aria-controls")).resolves.toBe(await page.getByRole("listbox").getAttribute("id"));
  const pressed = () => page.locator('.pc-command__scope[aria-selected="true"]').textContent();
  await expect(pressed()).resolves.toMatch(/^All/);
  await page.keyboard.press("Tab");
  await expect(pressed()).resolves.toMatch(/^Tasks/);
  expect(await page.locator(".pc-command__heading").allTextContents()).toEqual(["Tasks"]);
  await focused(page, 'input[role="combobox"]');
  await page.keyboard.press("Shift+Tab");
  await expect(pressed()).resolves.toMatch(/^All/);
  // A scope with no matches falls back to All, keeping matches elsewhere visible.
  await page.getByRole("tab", { name: /^Agents/ }).click();
  await expect(pressed()).resolves.toMatch(/^Agents/);
  await input.fill("keepalive");
  await page.getByRole("option", { name: /Add SSH keepalive/ }).waitFor();
  expect(await labels(page)).toEqual(["Add SSH keepalive to remote runs"]);
  await expect(pressed()).resolves.toMatch(/^All/);
  // Nothing matches: say so, offer New task, and let Enter run it.
  await input.fill("xyzzy plugin");
  await expect(page.getByRole("status").filter({ hasText: "Nothing matches" }).textContent()).resolves.toContain("xyzzy plugin");
  await expect(labels(page)).resolves.toEqual(["New task: “xyzzy plugin”", "Browse all tasks"]);
  // The aria-activedescendant still points at the first fallback.
  expect((await activeOption(page)).label).toBe("New task: “xyzzy plugin”");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox").count()).resolves.toBe(0);
  await page.waitForFunction(() => (window as any).newTask === 1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pacer.new-task.v1")!).request)).toBe("xyzzy plugin");
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
  // Unavailable actions have no shortcut hint and do nothing.
  const footer = await page.locator(".pc-command__footer").textContent();
  expect(footer).not.toContain("open beside");
  expect(footer).not.toContain("Coming soon");
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

browserTest("dialog_opening_commands_offer_only_plain_enter", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill(">shortcuts");
  await page.getByRole("option", { name: /^Show keyboard shortcuts/ }).waitFor();
  expect(await labels(page)).toEqual(["Show keyboard shortcuts"]);
  expect(await page.locator(".pc-command__footer").textContent()).not.toContain("run and keep open");
  // The shortcuts overlay is a dialog of its own; only plain Enter is offered.
  await page.keyboard.press("Enter");
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
  expect(await labels(page)).toEqual(["New task: “saved setup”"]);
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
  expect(t).toMatchObject({ w: 420, h: 26, radius: "6px", border: "1px", padL: "8px", caps: 1, text: "Search tasks, agents or run a command" });
  await trigger.click();
  await page.getByRole("combobox").fill("fix");
  await page.waitForTimeout(100);
  const m = await page.evaluate(() => {
    const css = (selector: string) => getComputedStyle(document.querySelector(selector)!), box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { dialogW: Math.round(box("dialog.pc-command").width), dialogTop: Math.round(box("dialog.pc-command").top), dialogRadius: css("dialog.pc-command").borderTopLeftRadius, rowH: Math.round(box(".pc-command__search").height), inputOutline: css(".pc-command__input").outlineStyle, inputOutlineWidth: css(".pc-command__input").outlineWidth, inputFocusVisible: document.querySelector(".pc-command__input")!.matches(":focus-visible"), focusRing: css(".pc-command__search").boxShadow.includes("inset") ? "inset" : css(".pc-command__search").boxShadow,
      optionRadius: css(".pc-command__option").borderTopLeftRadius, glyph: [Math.round(box(".pc-command__glyph").width), css(".pc-command__glyph").borderTopLeftRadius], markWeight: css(".pc-command__label mark").fontWeight,
      scopeH: Math.round(box(".pc-command__scope").height), scopeRadius: css(".pc-command__scope").borderTopLeftRadius, kbd: [css(".pc-command__footer kbd").borderTopLeftRadius, css(".pc-command__footer kbd").fontSize, Math.round(box(".pc-command__footer kbd").height)],
      placeholder: document.querySelector<HTMLInputElement>('input[role="combobox"]')!.placeholder, label: document.querySelector('input[role="combobox"]')!.getAttribute("aria-label") };
  });
  expect(m).toMatchObject({ dialogW: 640, dialogTop: 72, dialogRadius: "12px", rowH: 52, inputOutline: "solid", inputOutlineWidth: "2px", inputFocusVisible: true, focusRing: "none", optionRadius: "8px", glyph: [28, "6px"], markWeight: "700", scopeH: 24, scopeRadius: "6px", kbd: ["4px", "11px", 18],
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

browserTest("results arrive in a polite live region and an empty Files scope falls back to All", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await filesAnswer(page, { results: [] });
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill("fix");
  // An empty scope cannot hide existing results.
  await page.getByRole("tab", { name: /^Files 0/ }).waitFor();
  await page.getByRole("tab", { name: /^Files/ }).click();
  await expect(page.locator('.pc-command__scope[aria-selected="true"]').textContent()).resolves.toMatch(/^All/);
  const live = page.locator('.sr-only[role="status"]');
  await expect(live.textContent()).resolves.toMatch(/^\d+ results?/);
  // The combobox is described by the footer hint (what Enter does).
  const described = await input.getAttribute("aria-describedby");
  expect(await page.evaluate(id => document.getElementById(id!.split(" ").at(-1)!)?.textContent, described)).toContain("open");
}));


browserTest("recent_and_commands_keep_scope_tabs_and_keyboard_switching", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  const selected = page.locator('.pc-command__scope[aria-selected="true"]');
  expect(await page.getByRole("tab").count()).toBe(5);
  expect(await selected.textContent()).toBe("All");
  expect(await page.locator(".pc-command__scopes").textContent()).toContain("Tab switch");
  await page.keyboard.press("Tab");
  expect(await selected.textContent()).toMatch(/^Tasks/);
  expect(await page.locator(".pc-command__heading").allTextContents()).toEqual(["Recent", "Suggested"]);
  await page.keyboard.press("Shift+Tab");
  expect(await selected.textContent()).toMatch(/^All/);
  await page.keyboard.press("Shift+Tab");
  expect(await selected.textContent()).toMatch(/^Commands \d+$/);
  expect(await page.locator(".pc-command__prefix").textContent()).toBe("Commands");
  await page.keyboard.press("Tab");
  expect(await selected.textContent()).toMatch(/^All/);
  expect(await page.locator(".pc-command__prefix").count()).toBe(0);
  expect(await page.locator(".pc-command__footer").textContent()).not.toContain("ask assistant");
  await page.getByRole("combobox").fill(">xyzzy plugin");
  expect(await labels(page)).toEqual(["New task: “xyzzy plugin”"]);
  expect(await page.locator(".pc-command__footer").textContent()).not.toContain("run and keep open");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).newTask === 1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pacer.new-task.v1")!).request)).toBe("xyzzy plugin");
}));

browserTest("empty_state_preserves_an_existing_new_task_draft", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  const draft = { request: "Earlier request", repo: "acme/api", checks: '[{"id":"keep","text":"Keep this check","on":true}]', issueSource: "old issue", issueText: "Earlier request" };
  await page.evaluate(draft => localStorage.setItem("pacer.new-task.v1", JSON.stringify(draft)), draft);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("xyzzy replacement");
  const option = page.getByRole("option", { name: /New task: “xyzzy replacement”/ });
  await option.waitFor();
  expect(await option.locator(".pc-command__sub").count()).toBe(0);
  expect(await page.locator(".pc-command__footer").textContent()).toContain("↵ run");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).newTask === 1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pacer.new-task.v1")!))).toEqual(draft);
}));

browserTest("prefilling_a_mounted_composer_updates_in_place_only_when_empty", () => withPage(async (page, built) => {
  await open(page, built, "#/tasks/new");
  // Expose the composer's input boundary; the live harness also exercises the real NewTask screen.
  await page.evaluate(() => {
    const input = document.createElement("textarea"); input.id = "nt-request";
    input.addEventListener("input", () => { (window as any).composerRequest = input.value; });
    document.querySelector("#main-content")!.appendChild(input);
    (window as any).pageMarker = "same page";
  });
  for (const query of ["xyzzy first", "xyzzy second"]) {
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill(query);
    await page.getByRole("option", { name: new RegExp(`New task: “${query}”`) }).waitFor();
    await page.keyboard.press("Enter");
    expect(await page.locator("#nt-request").inputValue()).toBe("xyzzy first");
    expect(await page.evaluate(() => (window as any).composerRequest)).toBe("xyzzy first");
    expect(await page.evaluate(() => (window as any).pageMarker)).toBe("same page");
    expect(await page.evaluate(() => (window as any).newTask)).toBeUndefined();
  }
}));

browserTest("subtitles_and_scope_counts_meet_contrast_and_dark_overlay_uses_tokens", () => withPage(async (page, built) => {
  await open(page, built, "#/");
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("a");
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const measured = await page.evaluate(() => {
      const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (value: string) => rgb(value).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i]!, 0);
      const contrast = (foreground: string, background: string) => { const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
      const dialog = document.querySelector(".pc-command")!;
      const ratios = [...document.querySelectorAll(".pc-command__sub,.pc-command__count")].map(element => {
        let background: Element | null = element;
        while (background && getComputedStyle(background).backgroundColor === "rgba(0, 0, 0, 0)") background = background.parentElement;
        return contrast(getComputedStyle(element).color, getComputedStyle(background!).backgroundColor);
      });
      return { ratios, backdrop: getComputedStyle(dialog, "::backdrop").backgroundColor, shadow: getComputedStyle(dialog).boxShadow };
    });
    expect(measured.ratios.length).toBeGreaterThan(0);
    for (const ratio of measured.ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    if (theme === "dark") {
      expect(measured.backdrop).toBe("rgba(0, 0, 0, 0.6)");
      // Board 17 deliberately mixes ink into both shadow layers, including dark mode.
      expect(measured.shadow).toBe("color(srgb 0.980392 0.980392 0.980392 / 0.4) 0px 24px 64px -12px, color(srgb 0.980392 0.980392 0.980392 / 0.12) 0px 2px 6px 0px");
    }
  }
}));

browserTest("Commands mode shows the matched Commands count", () => withPage(async (page, built) => {
  await open(page, built, "#/dispatch");
  await page.keyboard.press("Meta+k");
  const input = page.getByRole("combobox");
  await input.fill(">count");
  const commands = page.getByRole("tab", {name:/^Commands/});
  expect(await commands.innerText()).toBe("Commands 1");
  await input.fill(">no-such-command");
  expect(await commands.innerText()).toBe("Commands 0");
}));

browserTest("Answer Escape restores its opening control inside Layout", () => withPage(async (page, built) => {
  await open(page, built, "?question#/needs-you");
  const answer = page.getByRole("link", {name:"Answer",exact:true}).first();
  expect(await page.locator(".ny-reason").evaluate(el=>({clamp:getComputedStyle(el).webkitLineClamp,whiteSpace:getComputedStyle(el).whiteSpace}))).toEqual({clamp:"2",whiteSpace:"normal"});
  await answer.focus();
  await answer.click();
  await page.getByRole("dialog").waitFor();
  expect(await page.locator(".pc-side-dialog__header h2").evaluate(el=>getComputedStyle(el).fontWeight)).toBe("650");
  expect(await page.getByRole("dialog").getByRole("link",{name:"Open session",exact:true}).evaluate(el=>getComputedStyle(el).color)).toBe(await page.locator(".pc-side-dialog").evaluate(el=>{const sample=document.createElement("span");sample.style.color="var(--link)";el.append(sample);const color=getComputedStyle(sample).color;sample.remove();return color;}));
  expect(await page.locator(".ny-resume").evaluate(el=>getComputedStyle(el).whiteSpace)).toBe("nowrap");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({state:"detached"});
  await page.waitForFunction(() => document.activeElement?.textContent === "Answer");
  expect(await answer.evaluate(el=>el===document.activeElement)).toBe(true);
}));

browserTest("Tasks owns its selected task aside with the shell Inspector toggle disabled", () => withPage(async (page, built) => {
  await open(page, built, "?task-list#/tasks");
  const aside = page.getByRole("complementary",{name:"Selected task"});
  await aside.waitFor();
  expect(await aside.isVisible()).toBe(true);
  expect(await page.getByRole("button", {name:"Hide Inspector"}).count()).toBe(0);
  expect(await page.getByRole("button", {name:"Toggle right panel", exact:true}).isDisabled()).toBe(true);
  expect(await page.getByRole("complementary", {name:"Inspector", exact:true}).count()).toBe(0);
  await page.keyboard.press("ControlOrMeta+Alt+b");
  expect(await aside.isVisible()).toBe(true);
  expect(await page.getByRole("complementary", {name:"Inspector", exact:true}).count()).toBe(0);
}));
