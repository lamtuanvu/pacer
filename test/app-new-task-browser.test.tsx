import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it these checks skip.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
type Stub = { explain?: "ok" | "missing" | "unknown" | "error"; delegate?: "ok" | "fail"; mode?: string; issue?: "ok" | "error" | "import-only" | "invalid-url"; route?: "queue" | "fail" | "fallback" | "override" | "built-in-fail" | "built-in-select" | "built-in-queue" | "uncertain" | "engine-not-running" };

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
    await page.waitForFunction(() => location.hash === "#/tasks");
    expect(await calls(page, "task.delegate")).toEqual([expect.objectContaining({ goal: REQUEST, repo: "econ-v1/node", kind: "feature", worktree: "new", dispatch: { allowDelegation: true, maxConcurrent: 3 }, source: "ui" })]);
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
      "summary:More options · planner may split it · up to 3 in parallel · no deadline",
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
      await page.waitForFunction(() => location.hash === "#/tasks");
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
    await page.locator('[data-route="dispatch"]').waitFor();
    await page.locator("#main-content").focus();
    await page.keyboard.press("Meta+n");
    await page.waitForFunction(() => location.hash === "#/tasks/new?repo=econ-v1%2Fnode");
    await focused(page, "#nt-request").catch(async () => { throw new Error(JSON.stringify(await page.evaluate(() => ({ active: document.activeElement?.outerHTML, requests: document.querySelectorAll("#nt-request").length })))); });
  }, { hash: "#/?repo=econ-v1%2Fnode" });
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
    await sheet.getByText("Feature work matches ladder step 1", { exact: true }).waitFor();
    await sheet.getByText(/^Planner ≈ 60k tokens/).waitFor();
    // Each row opens its own sheet; focus returns to the row.
    const kindRow = sheet.getByRole("button", { name: /^Kind/ });
    await expect(kindRow.textContent()).resolves.toContain("Feature");
    await kindRow.click();
    const kind = page.getByRole("dialog", { name: "Kind" });
    await kind.getByRole("radio", { name: "Docs" }).waitFor();
    // Every control in a phone sheet keeps a 44 px target (UI-16).
    const short = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".pc-sheet button, .pc-sheet [role=radio], .pc-sheet a[href]")]
      .filter(el => el.getClientRects().length && el.getBoundingClientRect().height < 44).map(el => el.textContent?.trim() || el.getAttribute("aria-label")));
    expect(short).toEqual([]);
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
    await page.waitForFunction(() => location.hash === "#/tasks");
    expect(await calls(page, "task.delegate")).toEqual([expect.objectContaining({ kind: "docs", worktree: "current" })]);
  }, { width: 375, height: 812 });
}, 30_000);

browserTest("new_task_375_sheet_closes_with_escape", async () => {
  await withComposer(async page => {
    await page.getByRole("dialog", { name: "New task" }).waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => location.hash === "#/");
  }, { width: 375, height: 812 });
}, 30_000);

browserTest("new_task_submit_never_uses_a_stale_preview_and_keeps_a_mention_added_with_cmd_enter", async () => {
  await withComposer(async page => {
    await focused(page, "#nt-request");
    await page.keyboard.type(REQUEST);
    await page.getByRole("radio", { name: /Feature · detected/ }).waitFor();
    // New text, submitted before the preview refreshes: the old detected kind is not sent.
    await page.locator("#nt-request").fill("Document the config flags.");
    await page.getByRole("button", { name: "Mention a file or folder" }).click();
    await page.getByRole("textbox", { name: "File or folder in the repository" }).fill("docs/config.md");
    await page.keyboard.press("Meta+Enter");
    await page.waitForFunction(() => location.hash === "#/tasks");
    const [params] = await calls(page, "task.delegate");
    expect(params).toMatchObject({ goal: "Document the config flags.", scope: "docs/config.md" });
    expect(params.kind).toBeUndefined();
  });
}, 30_000);

for (const [route, label, reason] of [
  ["queue", "Waits in queue", "Codex is busy; the task waits for a free slot"],
  ["fail", "Can't start", "No agent in your dispatcher setup can take this task right now"],
  ["fallback", "Ladder step 2 · Codex skipped", "Codex is out of budget"],
  ["override", "Chosen by you · this task only", "Skips the dispatcher ladder for this task"],
] as const) {
  browserTest(`new_task_route_${route}_has_plain_reason`, async () => {
    await withComposer(async page => {
      await page.locator("#nt-request").fill(REQUEST);
      const card = page.getByRole("region", { name: "Will go to" });
      await card.getByText(label, { exact: true }).waitFor();
      await card.getByText(reason, { exact: true }).waitFor();
      expect(await card.textContent()).not.toContain("Internal text must not be shown");
    }, { stub: { route } });
  }, 30_000);
}

browserTest("new_task_issue_option_is_feature_gated", async () => {
  await withComposer(async page => {
    expect(await page.getByRole("button", { name: "From an issue" }).count()).toBe(0);
  });
}, 30_000);

for (const width of [1440, 375]) {
  browserTest(`new_task_issue_picker_plain_text_and_provenance_${width}`, async () => {
    await withComposer(async page => {
      await page.locator("#nt-request").fill("My request");
      await page.getByRole("button", { name: "From an issue" }).click();
      const picker = page.getByRole("dialog", { name: "From an issue" });
      await picker.getByRole("textbox").fill("failure");
      await picker.getByRole("button", { name: "Search issues", exact: true }).click();
      await picker.getByRole("button", { name: "#42 <img src=x onerror=alert(1)>" }).click();
      await picker.getByText("<script>window.issueExecuted=true</script>", { exact: false }).waitFor();
      expect(await picker.locator("img,script").count()).toBe(0);
      await picker.getByRole("button", { name: "Use issue text" }).click();
      await page.getByRole("note").filter({ hasText: "Imported from issue:" }).waitFor();
      expect(await page.locator("#nt-request").inputValue()).toContain("My request");
      expect(await page.locator("#nt-request").inputValue()).toContain("<script>window.issueExecuted=true</script>");
      expect(await calls(page, "issue.search")).toEqual([{ repo: "econ-v1/node", query: "failure", state: "open", limit: 20 }]);
      expect(await calls(page, "issue.import")).toEqual([{ repo: "econ-v1/node", issue: "42" }]);
      await page.getByRole("button", { name: /^Delegate task/ }).click();
      await page.waitForFunction(() => location.hash === "#/tasks");
      expect((await calls(page, "task.delegate"))[0].context).toContain("Imported from issue https://github.com/econ-v1/node/issues/42");
    }, { width, height: 900, stub: { issue: "ok" } });
  }, 30_000);
}

browserTest("new_task_issue_picker_errors_and_cancel_preserve_draft", async () => {
  await withComposer(async page => {
    await page.locator("#nt-request").fill("Keep my request");
    await page.getByRole("button", { name: "From an issue" }).click();
    const picker = page.getByRole("dialog", { name: "From an issue" });
    await picker.getByRole("textbox").fill("test");
    await picker.getByRole("button", { name: "Search issues", exact: true }).click();
    await picker.getByRole("alert").getByText("gh is not signed in. Run gh auth login, then retry.").waitFor();
    await page.keyboard.press("Escape");
    expect(await page.locator("#nt-request").inputValue()).toBe("Keep my request");
  }, { stub: { issue: "error" } });
}, 30_000);

browserTest("new_task_issue_picker_can_import_without_search", async () => {
  await withComposer(async page => {
    await page.getByRole("button", { name: "From an issue" }).click();
    const picker = page.getByRole("dialog", { name: "From an issue" });
    expect(await picker.getByRole("button", { name: "Search issues" }).count()).toBe(0);
    await picker.getByRole("textbox").fill("https://github.com/econ-v1/node/issues/42");
    await picker.getByRole("button", { name: "Read issue", exact: true }).click();
    await picker.getByRole("button", { name: "Use issue text" }).waitFor();
    expect(await calls(page, "issue.search")).toEqual([]);
    await picker.getByRole("button", { name: "Close", exact: true }).click();
    expect(await page.locator("#nt-request").inputValue()).toBe("");
  }, { stub: { issue: "import-only" } });
}, 30_000);

for (const width of [1440, 768, 375]) for (const dark of [false, true]) {
  browserTest(`new_task_board_typography_and_containment_${width}_${dark ? "dark" : "light"}`, async () => {
    await withComposer(async page => {
      await page.locator("#nt-request").fill(REQUEST);
      await page.getByText(width === 375 ? "Ready" : "Ladder step 1 · strategy no-agy", { exact: true }).waitFor();
      const geometry = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector("#nt-request")!);
        const name = getComputedStyle(document.querySelector(".pc-route-card__name")!);
        const title = document.querySelector(".pc-sheet__title");
        return {
          requestSize: style.fontSize, requestLine: style.lineHeight, agentSize: name.fontSize,
          titleSize: title ? getComputedStyle(title).fontSize : null,
          overflow: document.scrollingElement!.scrollWidth > innerWidth,
        };
      });
      expect(geometry).toMatchObject({ requestSize: "14px", requestLine: width === 375 ? "20px" : "21px", agentSize: width === 375 ? "14px" : "16px", overflow: false });
      if (width === 375) expect(geometry.titleSize).toBe("16px");
      const evidence = process.env.PACER_COMPOSER_EVIDENCE;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `composer-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
        await page.getByRole("button", { name: "From an issue" }).click();
        const picker = page.getByRole("dialog", { name: "From an issue" });
        await picker.getByRole("textbox").fill("42");
        await picker.getByRole("button", { name: "Read issue", exact: true }).click();
        await picker.getByRole("button", { name: "Use issue text" }).waitFor();
        await page.screenshot({ path: join(evidence, `issue-picker-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
      }
    }, { width, height: 900, dark, stub: { issue: "ok" } });
  }, 30_000);
}

for (const route of ["built-in-fail", "built-in-select", "built-in-queue", "fail", "uncertain", "engine-not-running"] as const) {
  browserTest(`new_task_preview_${route}_never_blocks_delegate`, async () => {
    await withComposer(async page => {
      await page.locator("#nt-request").fill(REQUEST);
      const card = page.getByRole("region", { name: "Will go to" });
      await card.getByText(route === "fail" ? "Can't start" : "Preview only", { exact: true }).waitFor();
      if (route.startsWith("built-in-")) {
        expect(await card.locator(".pc-route-card__lead").count()).toBe(0);
        expect(await card.textContent()).not.toContain("Ladder step");
        await card.getByText(/this preview is advisory/).waitFor();
      }
      if (route === "uncertain") {
        await card.getByText("Agent capacity has not been measured yet").waitFor();
        await card.getByText(/uses cached information/).waitFor();
      }
      if (route === "engine-not-running") await card.getByText(/engine is not running/).waitFor();
      const delegate = page.getByRole("button", { name: /^Delegate task/ });
      expect(await delegate.isDisabled()).toBe(false);
      await delegate.click();
      await page.waitForFunction(() => location.hash === "#/tasks");
      expect((await calls(page, "task.delegate")).length).toBe(1);
    }, { stub: { route } });
  }, 30_000);
}

for (const width of [1440, 375]) browserTest(`new_task_issue_picker_traps_tab_and_enter_searches_${width}`, async () => {
  await withComposer(async page => {
    await page.getByRole("button", { name: "From an issue" }).click();
    const picker = page.getByRole("dialog", { name: "From an issue" });
    const assertCycle = async () => {
      for (const key of ["Tab", "Shift+Tab"]) for (let i = 0; i < 10; i++) {
        await page.keyboard.press(key);
        expect(await picker.evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
      }
    };
    await picker.getByRole("textbox").focus();
    await assertCycle();
    await picker.getByRole("textbox").fill("failure");
    await picker.getByRole("textbox").press("Enter");
    const result = picker.getByRole("button", { name: "#42 <img src=x onerror=alert(1)>" });
    await result.waitFor();
    expect(await calls(page, "issue.search")).toEqual([{ repo: "econ-v1/node", query: "failure", state: "open", limit: 20 }]);
    await assertCycle();
    await result.click();
    await picker.getByRole("button", { name: "Use issue text" }).waitFor();
    await assertCycle();
    await page.keyboard.press("Escape");
    expect(await picker.count()).toBe(0);
    expect(await calls(page, "task.delegate")).toEqual([]);
  }, { width, height: 900, stub: { issue: "ok" } });
}, 30_000);

for (const action of ["remove", "empty", "replace"] as const) browserTest(`new_task_issue_provenance_clears_on_${action}`, async () => {
  await withComposer(async page => {
    await page.locator("#nt-request").fill("Original request");
    await page.getByRole("button", { name: "From an issue" }).click();
    const picker = page.getByRole("dialog", { name: "From an issue" });
    await picker.getByRole("textbox").fill("42");
    await picker.getByRole("textbox").press("Enter");
    await picker.getByRole("button", { name: "Use issue text" }).click();
    const note = page.getByRole("note").filter({ hasText: "Imported from issue:" });
    await note.waitFor();
    if (action === "remove") {
      const before = await page.locator("#nt-request").inputValue();
      await note.getByRole("button", { name: "Remove source" }).click();
      expect(await page.locator("#nt-request").inputValue()).toBe(before);
    } else {
      await page.locator("#nt-request").fill(action === "empty" ? "" : "Original request");
    }
    expect(await note.count()).toBe(0);
    if (action === "empty") await page.locator("#nt-request").fill("Fresh request");
    await page.getByRole("button", { name: /^Delegate task/ }).click();
    await page.waitForFunction(() => location.hash === "#/tasks");
    expect((await calls(page, "task.delegate"))[0].context).toBeUndefined();
  }, { stub: { issue: "import-only" } });
}, 30_000);

browserTest("new_task_issue_invalid_service_url_is_visible_and_not_imported", async () => {
  await withComposer(async page => {
    await page.getByRole("button", { name: "From an issue" }).click();
    const picker = page.getByRole("dialog", { name: "From an issue" });
    await picker.getByRole("textbox").fill("42");
    await picker.getByRole("button", { name: "Read issue", exact: true }).click();
    await picker.getByRole("alert").getByText(/invalid GitHub issue URL/).waitFor();
    expect(await picker.getByRole("button", { name: "Use issue text" }).count()).toBe(0);
    expect(await page.locator("#nt-request").inputValue()).toBe("");
  }, { stub: { issue: "invalid-url" } });
}, 30_000);

browserTest("new_task_375_card_has_one_summary_reason_line", async () => {
  await withComposer(async page => {
    await page.locator("#nt-request").fill(REQUEST);
    const card = page.getByRole("region", { name: "Where this task goes" });
    await card.getByText("Ready", { exact: true }).waitFor();
    expect(await card.locator(".pc-route-card__why > li").count()).toBe(1);
    const summary = card.locator(".pc-route-card__why > li > span:last-child");
    expect(await summary.evaluate(el => getComputedStyle(el).whiteSpace)).toBe("nowrap");
    expect(await summary.getAttribute("title")).toContain("spare capacity");
    expect(await card.textContent()).not.toContain("strategy no-agy");
    const lines = await card.evaluate(el => {
      const textLines = (selector: string) => {
        const node = el.querySelector(selector)!;
        const style = getComputedStyle(node);
        return node.getBoundingClientRect().height / parseFloat(style.lineHeight);
      };
      const planner = el.querySelector(".pc-route-card__compact-planner") as HTMLElement;
      return {
        label: textLines(".pc-label"), name: textLines(".pc-route-card__name"),
        summary: textLines(".pc-route-card__why"), planner: textLines(".pc-route-card__compact-planner"),
        plannerText: planner.textContent, plannerTitle: planner.title,
        plannerOverflow: getComputedStyle(planner).textOverflow,
        whoChildren: el.querySelector(".pc-route-card__who")!.children.length,
      };
    });
    expect(lines).toMatchObject({ label: 1, name: 1, summary: 1, planner: 1, whoChildren: 2, plannerOverflow: "ellipsis" });
    expect(lines.plannerTitle).toBe(lines.plannerText);
    expect(lines.plannerTitle).toContain("median of 12 similar tasks");
  }, { width: 375, height: 812 });
}, 30_000);

browserTest('canvas_new_task_has_breadcrumb_above_title_and_cancel_returns_to_dispatch', async()=>{
 await withComposer(async page=>{
  const geometry=await page.evaluate(()=>({crumb:document.querySelector('.pc-new-task__crumb')!.getBoundingClientRect().top,title:document.querySelector('.pc-new-task__title')!.getBoundingClientRect().top}));
  expect(geometry.crumb).toBeLessThan(geometry.title);
  await page.getByRole('button',{name:'Cancel',exact:true}).first().click();
  await page.waitForFunction(()=>location.hash==='#/');
 });
},15000);

browserTest("repository_picker_identity_and_attachment_size_match_the_board", async () => {
  await withComposer(async page => {
    const picker = page.locator(".pc-new-task__pick .pc-choice-picker__trigger");
    await page.locator(".pc-new-task__pick .pc-choice-picker__branch").waitFor();
    expect(await picker.locator("svg").count()).toBe(1);
    expect(await picker.locator("strong").textContent()).toBe("econ-v1/node");
    expect(await picker.locator(".pc-choice-picker__branch").textContent()).toBe("main");
    expect(await picker.evaluate(el => ({ gap: getComputedStyle(el).gap, height: el.getBoundingClientRect().height }))).toEqual({ gap: "10px", height: 40 });
    await page.getByLabel("Attach a file", { exact: true }).setInputFiles({ name: "too-big.log", mimeType: "text/plain", buffer: Buffer.alloc(10_000_001) });
    await page.getByText("Attachment exceeds 10 MB", { exact: true }).waitFor();
    expect(await calls(page, "session.draft.create")).toEqual([]);
  });
});
