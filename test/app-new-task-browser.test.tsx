import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it these checks skip.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
type Stub = { explain?: "ok" | "missing" | "unknown" | "error"; delegate?: "ok" | "fail"; mode?: string };

let built: Promise<{ source: string; css: string }> | undefined;
function composer() {
  built ??= (async () => {
    const build = await Bun.build({ entrypoints: ["test/fixtures/app-new-task-browser.tsx"], target: "browser", splitting: false });
    expect(build.success).toBe(true);
    const css = [generateTokensCss(readTokens("app/src/ds")), ...await Promise.all(["app/src/ds/components.css", "app/src/ds/feedback.css", "app/src/styles.css", "app/src/screens/new-task/new-task.css"].map(path => Bun.file(path).text()))].join("\n");
    return { source: await build.outputs[0]!.text(), css };
  })();
  return built;
}
async function withComposer(run: (page: Page) => Promise<void>, opts: { stub?: Stub; width?: number; height?: number; hash?: string; dark?: boolean } = {}) {
  const { source, css } = await composer();
  const browser: Browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    // A fresh context per case, so the saved draft in localStorage never leaks between cases.
    const context = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 1000 }, colorScheme: opts.dark ? "dark" : "light" });
    const page = await context.newPage();
    await page.route("http://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>composer</title><div id="app"></div>' }));
    await page.addInitScript(stub => { (window as unknown as { newTaskStub: Stub }).newTaskStub = stub; }, opts.stub ?? {});
    await page.goto(`http://pacer.test/${opts.hash ?? "#/tasks/new"}`);
    await page.evaluate(text => { document.head.insertAdjacentHTML("beforeend", `<style>body{margin:0;background:var(--surface-page);color:var(--ink);font-family:var(--font-sans);font-size:var(--type-body-size);line-height:var(--type-body-line)}${text}</style>`); }, css);
    await page.evaluate(async code => { const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })); await import(url); URL.revokeObjectURL(url); }, source);
    await page.locator("#main-content").waitFor({ state: "attached" });
    await run(page);
  } finally { await browser.close(); }
}
const focused = (page: Page, selector: string) => page.waitForFunction(at => document.activeElement?.matches(at), selector, { timeout: 3000 });
const calls = (page: Page, op: string) => page.evaluate(op => (window as unknown as { newTaskCalls: { op: string; params: any }[] }).newTaskCalls.filter(c => c.op === op).map(c => c.params), op);
const focusName = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return "";
  const labelled = el.getAttribute("aria-labelledby");
  const name = el.getAttribute("aria-label") ?? (labelled ? document.getElementById(labelled)?.textContent : null) ?? (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ?? el.textContent ?? "";
  return `${el.getAttribute("role") ?? el.tagName.toLowerCase()}:${name.trim().replace(/\s+/g, " ")}`;
});
const REQUEST = "Make remote-support access opt-out. New installs start with it off; existing nodes keep their current choice.";

browserTest("new_task_desktop_ready_flow_delegates_with_cmd_enter", async () => {
  await withComposer(async page => {
    await focused(page, "#nt-request");
    // Empty draft: the board's draft state.
    await page.getByText("Describe the task to see where it goes").waitFor();
    const delegate = page.getByRole("button", { name: /^Delegate task/ });
    await expect(delegate.isDisabled()).resolves.toBe(true);
    await page.getByText("Write a request to continue", { exact: true }).waitFor();
    await page.keyboard.type(REQUEST);
    const card = page.getByRole("region", { name: "Will go to" });
    await card.getByText("Ladder step 1 · strategy no-agy").waitFor();
    await card.getByText("Ready", { exact: true }).waitFor();
    await card.getByText("Updated as you type").waitFor();
    await card.getByText("If it can't:").waitFor();
    await card.getByText("≈ 60k tokens").waitFor();
    expect((await calls(page, "dispatch.explain")).at(-1)).toEqual({ repo: "econ-v1/node", goal: REQUEST });
    await expect(page.getByRole("radio", { name: /Feature · detected/ }).getAttribute("aria-checked")).resolves.toBe("true");
    await page.getByText("Starts in a new worktree on econ-v1/node · you can watch it in Tasks").waitFor();
    await page.getByText("Draft saved just now").waitFor();
    await page.keyboard.press("Meta+Enter");
    await page.waitForFunction(() => location.hash.startsWith("#/tasks/t-"));
    expect(await calls(page, "task.delegate")).toEqual([expect.objectContaining({ goal: REQUEST, repo: "econ-v1/node", kind: "feature", worktree: "new", source: "ui" })]);
    // A delegated task clears the saved draft.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pacer.new-task.v1") ?? "{}").request ?? "")).toBe("");
  });
}, 30_000);

browserTest("new_task_focus_order_and_radio_keys", async () => {
  await withComposer(async page => {
    await focused(page, "#nt-request");
    await page.keyboard.type(REQUEST);
    await page.getByRole("region", { name: "Will go to" }).getByText("Ready", { exact: true }).waitFor();
    const order: string[] = [];
    for (let i = 0; i < 9; i++) { await page.keyboard.press("Tab"); order.push(await focusName(page)); }
    // One stop per radio group, then the aside in reading order, ending on the primary action.
    expect(order).toEqual([
      "input:Attach a file",
      "button:Mention a file or folder",
      "button:Repository",
      "radio:New worktreeRecommendedIsolated copy · your checkout stays untouched",
      "radio:Feature· detected",
      "button:Add a check",
      "summary:More options · base branch main",
      "summary:Send to a specific agent · this task only",
      "button:Delegate task⌘↵",
    ]);
    // Before the request: the header's crumb and actions.
    await page.locator("#nt-request").focus();
    const back: string[] = [];
    for (let i = 0; i < 3; i++) { await page.keyboard.press("Shift+Tab"); back.push(await focusName(page)); }
    expect(back).toEqual(["button:Cancel", "button:Save draft", "a:Tasks ›"]);
    // Arrow keys move the workspace choice; Shift+Tab walks back.
    await page.getByRole("radio", { name: /New worktree/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: /Current checkout/ }).getAttribute("aria-checked")).resolves.toBe("true");
    await focused(page, '[role="radio"][aria-checked="true"]');
    await page.getByText("Starts in the current checkout on econ-v1/node · you can watch it in Tasks").waitFor();
    await page.keyboard.press("Shift+Tab");
    expect(await focusName(page)).toBe("button:Repository");
    // The override list is a radio group too; unavailable agents stay listed but cannot be chosen.
    await page.getByText("Send to a specific agent").click();
    const agents = page.getByRole("radiogroup", { name: "Agent for this task" });
    await expect(agents.getByRole("radio").count()).resolves.toBe(4);
    await expect(agents.getByRole("radio", { name: /No active subscription/ }).getAttribute("aria-disabled")).resolves.toBe("true");
  });
}, 30_000);

for (const explain of ["missing", "unknown"] as const) {
  browserTest(`new_task_routing_preview_unavailable_when_op_${explain}`, async () => {
    await withComposer(async page => {
      await focused(page, "#nt-request");
      await page.keyboard.type(REQUEST);
      await page.getByText("Routing preview isn't available").waitFor();
      await page.getByText("This pacer service can't explain routes yet. pacer still picks the agent from your dispatcher setup when you delegate.").waitFor();
      expect((await calls(page, "dispatch.explain")).length).toBe(explain === "missing" ? 0 : 1);
      // The composer still delegates without a preview, and without a detected kind.
      const delegate = page.getByRole("button", { name: /^Delegate task/ });
      await expect(delegate.isDisabled()).resolves.toBe(false);
      await delegate.click();
      await page.waitForFunction(() => location.hash.startsWith("#/tasks/t-"));
      const [params] = await calls(page, "task.delegate");
      expect(params.kind).toBeUndefined();
    }, { stub: { explain } });
  }, 30_000);
}

browserTest("new_task_routing_preview_error_and_start_failure", async () => {
  await withComposer(async page => {
    await focused(page, "#nt-request");
    await page.keyboard.type(REQUEST);
    await page.getByText("Couldn't check where it goes: The routing engine timed out.").waitFor();
    await page.getByRole("radio", { name: /Current checkout/ }).click();
    await page.getByRole("button", { name: /^Delegate task/ }).click();
    const alert = page.getByRole("alert");
    await alert.getByText("pacer couldn't start this task").waitFor();
    await alert.getByText(/3 uncommitted files.*Your request is kept as a draft\./).waitFor();
    await page.getByText("Kept as a draft", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Try again in a new worktree/ }).waitFor();
    await page.getByText("Your request, checks and agent choice are kept").waitFor();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pacer.new-task.v1") ?? "{}").request)).toBe(REQUEST);
    await alert.getByRole("button", { name: "Use a new worktree" }).click();
    await expect(alert.count()).resolves.toBe(0);
    await expect(page.getByRole("radio", { name: /New worktree/ }).getAttribute("aria-checked")).resolves.toBe("true");
  }, { stub: { explain: "error", delegate: "fail" } });
}, 30_000);

browserTest("new_task_strict_planner_notice", async () => {
  await withComposer(async page => {
    await focused(page, "#nt-request");
    await page.keyboard.type(REQUEST);
    await page.getByText(/is in strict mode/i).waitFor();
    await page.getByText("9 points ahead of pace. Planning stays short. It still starts now.").waitFor();
    await page.getByRole("link", { name: "Budget & pacing" }).waitFor();
  }, { stub: { mode: "strict" } });
}, 30_000);

browserTest("new_task_cmd_n_opens_the_composer_from_anywhere", async () => {
  await withComposer(async page => {
    await page.locator('[data-route="overview"]').waitFor();
    await page.locator("#main-content").focus();
    await page.keyboard.press("Meta+n");
    await page.waitForFunction(() => location.hash === "#/tasks/new?repo=econ-v1%2Fnode");
    await focused(page, "#nt-request");
  }, { hash: "#/overview?repo=econ-v1%2Fnode" });
}, 30_000);

browserTest("new_task_375_sheet_rows_open_sheets", async () => {
  await withComposer(async page => {
    const sheet = page.getByRole("dialog", { name: "New task" });
    await sheet.waitFor();
    await focused(page, "#nt-request");
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const root = document.scrollingElement!;
      return { sheet: box(".pc-sheet"), head: box(".pc-sheet__head"), delegate: box(".pc-sheet__foot .pc-new-task__delegate"), foot: box(".pc-sheet__foot"), overflow: root.scrollWidth > root.clientWidth };
    });
    expect(geometry.sheet).toMatchObject({ x: 0, y: 0, width: 375, height: 812 });
    expect(geometry.head.height).toBe(52);
    expect(geometry.delegate.width).toBe(375 - 32);
    expect(geometry.foot.bottom).toBe(812);
    expect(geometry.overflow).toBe(false);
    await sheet.getByRole("button", { name: "Save draft" }).waitFor();
    await page.keyboard.type(REQUEST);
    await sheet.getByText("Ladder step 1 · strategy no-agy").waitFor();
    await sheet.getByText(/^Planner ≈ 60k tokens/).waitFor();
    // Each row opens its own sheet; focus returns to the row.
    const kindRow = sheet.getByRole("button", { name: /^Kind/ });
    await expect(kindRow.textContent()).resolves.toContain("Feature");
    await kindRow.click();
    const kind = page.getByRole("dialog", { name: "Kind" });
    await kind.getByRole("radio", { name: "Docs" }).click();
    await kind.getByRole("button", { name: "Done" }).click();
    await expect(kind.count()).resolves.toBe(0);
    await expect(kindRow.textContent()).resolves.toContain("Docs");
    await focused(page, ".pc-drill-row:nth-child(3)");
    await sheet.getByRole("button", { name: /^Where it runs/ }).click();
    await page.getByRole("dialog", { name: "Where it runs" }).getByRole("radio", { name: /Current checkout/ }).click();
    await page.keyboard.press("Escape");
    await expect(sheet.getByRole("button", { name: /^Where it runs/ }).textContent()).resolves.toContain("Current checkout");
    await sheet.getByText("Starts in the current checkout on econ-v1/node").waitFor();
    await sheet.getByRole("button", { name: /^Delegate task/ }).click();
    await page.waitForFunction(() => location.hash.startsWith("#/tasks/t-"));
    expect(await calls(page, "task.delegate")).toEqual([expect.objectContaining({ kind: "docs", worktree: "current" })]);
  }, { width: 375, height: 812 });
}, 30_000);

browserTest("new_task_375_sheet_closes_with_escape", async () => {
  await withComposer(async page => {
    await page.getByRole("dialog", { name: "New task" }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => location.hash === "#/tasks");
  }, { width: 375, height: 812 });
}, 30_000);
