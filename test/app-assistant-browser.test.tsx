import { expect, test } from "bun:test";
import { chromium, webkit, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it these checks skip.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
// The desktop app is a WebKit window. Run with PACER_TEST_WEBKIT=1 after `bunx playwright-core install webkit`.
const webkitTest = test.skipIf(!process.env.PACER_TEST_WEBKIT);

async function build() {
  const result = await Bun.build({ entrypoints: ["test/fixtures/app-assistant-browser.tsx"], target: "browser", splitting: false });
  expect(result.success).toBe(true);
  const css = [generateTokensCss(readTokens("app/src/ds")), ...await Promise.all(["app/src/ds/components.css", "app/src/ds/feedback.css", "app/src/styles.css", "app/src/shell/assistant/assistant.css"].map(path => Bun.file(path).text()))].join("\n");
  return { source: await result.outputs[0]!.text(), css };
}
async function open(page: Page, built: { source: string; css: string }, search = "") {
  await page.route("http://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>assistant</title><div id="app"></div>' }));
  await page.goto(`http://pacer.test/${search}#/dispatch`);
  await page.evaluate(css => { document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`); }, built.css);
  await page.evaluate(async code => { const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })); await import(url); URL.revokeObjectURL(url); }, built.source);
  await page.locator("#main-content").waitFor();
}
const focused = (page: Page, selector: string) => page.waitForFunction(at => document.activeElement?.matches(at), selector, { timeout: 2000 });
/** The sheet loads lazily after first paint: wait for its launcher before using the shortcut. */
async function openSheet(page: Page) {
  await page.getByRole("button", { name: "Open assistant" }).waitFor();
  await page.keyboard.press("Meta+j");
  await focused(page, 'input[aria-label="Ask pacer"]');
}
const animating = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".pc-aurora__glow span")].map(el => getComputedStyle(el).animationName));

browserTest("assistant_opens_with_meta_j_focuses_input_and_escape_returns_focus", async () => {
  const built = await build();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built);
    const launcher = page.getByRole("button", { name: "Open assistant" });
    await launcher.waitFor();
    await expect(launcher.getAttribute("aria-expanded")).resolves.toBe("false");
    // The sheet stays mounted but inert and hidden while closed.
    expect(await page.locator(".pc-aurora").getAttribute("data-state")).toBe("closed");
    await launcher.focus();
    await page.keyboard.press("Meta+j");
    await focused(page, 'input[aria-label="Ask pacer"]');
    await expect(page.getByRole("button", { name: "Close assistant" }).getAttribute("aria-expanded")).resolves.toBe("true");
    await expect(page.getByRole("region", { name: "Assistant" }).isVisible()).resolves.toBe(true);
    await page.keyboard.press("Escape");
    await focused(page, '[aria-label="Open assistant"]');
    expect(await page.evaluate(() => (window as any).pageEscapes)).toBe(0);
    expect(await page.locator(".pc-aurora").getAttribute("data-state")).toBe("closed");
    // Ctrl-J toggles through the shortcut registry; Meta-J again closes.
    await page.keyboard.press("Control+j");
    await focused(page, 'input[aria-label="Ask pacer"]');
    await page.keyboard.press("Meta+j");
    expect(await page.locator(".pc-aurora").getAttribute("data-state")).toBe("closed");
  } finally { await browser.close(); }
}, 20_000);

browserTest("assistant_announces_only_the_finished_answer_in_a_polite_log", async () => {
  const built = await build();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built);
    await openSheet(page);
    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log.getAttribute("aria-live")).resolves.toBe("polite");
    await page.getByRole("button", { name: "What needs me today?" }).click();
    // While generating, the streamed text is hidden from assistive technology.
    await page.getByText("partial text that must not be announced").waitFor();
    expect(await page.evaluate(() => !!document.querySelector('.pc-aurora__log [aria-hidden="true"] .pc-prose'))).toBe(true);
    await log.getByText("Three tasks need you.").waitFor();
    expect(await page.evaluate(() => document.querySelector(".pc-aurora__log")!.textContent!.includes("must not be announced"))).toBe(false);
    // The finished answer links to the task it came from.
    await expect(log.getByRole("link", { name: "t-20261028-101010-ab12" }).getAttribute("href")).resolves.toBe("#/tasks/t-20261028-101010-ab12");
    await expect(page.evaluate(() => (window as any).asked[0].scope)).resolves.toEqual({ kind: "dispatch", days: 7 });
  } finally { await browser.close(); }
}, 20_000);

browserTest("assistant_aurora_moves_only_while_generating_and_never_under_reduced_motion", async () => {
  const built = await build();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
      await open(page, built);
      await openSheet(page);
      // At rest it is still, with or without the preference.
      expect((await animating(page)).every(name => name === "none")).toBe(true);
      await page.keyboard.type("how is the budget");
      await page.keyboard.press("Enter");
      await page.getByText("Thinking…").first().waitFor();
      const names = await animating(page);
      if (reducedMotion === "reduce") expect(names.every(name => name === "none")).toBe(true);
      else expect(names.every(name => name !== "none")).toBe(true);
      // Under reduced motion the sheet's own open and close are instant.
      if (reducedMotion === "reduce") expect(await page.locator(".pc-aurora").evaluate(el => getComputedStyle(el).transitionDuration)).toBe("0s");
      await page.getByText("Three tasks need you.").waitFor();
      expect((await animating(page)).every(name => name === "none")).toBe(true);
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

browserTest("assistant_card_is_the_only_primary_control_and_runs_only_after_a_click", async () => {
  const built = await build();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built);
    await openSheet(page);
    await page.keyboard.type("please retry the failed task");
    await page.keyboard.press("Enter");
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    expect(await page.evaluate(() => (window as any).recorded.length)).toBe(0);
    // The assistant's words are labelled, and the host's summary is not the model's text.
    await page.getByText("The assistant's note").waitFor();
    expect(await page.locator(".pc-aurora .pc-btn--primary").count()).toBe(1);
    await retry.click();
    await page.getByText("Done.").waitFor();
    const recorded = await page.evaluate(() => (window as any).recorded);
    expect(recorded[0].op).toBe("dispatch.retry");
    expect(recorded[0].params).toMatchObject({ id: "t-20261028-101010-ab12", expect_rev: 3 });
    expect(typeof recorded[0].params.requestId).toBe("string");
    expect(recorded.at(-1)).toMatchObject({ cardId: "card-1", state: "done" });
    // A settled card offers nothing further.
    expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
  } finally { await browser.close(); }
}, 20_000);

browserTest("assistant_sheet_fits_phone_width_with_a_visible_input_and_forced_colors_drops_the_aurora", async () => {
  const built = await build();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await open(page, built);
    await openSheet(page);
    const input = page.getByLabel("Ask pacer");
    await input.waitFor();
    const box = (await input.boundingBox())!;
    expect(box.width).toBeGreaterThan(150);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth)).toBe(true);
    // The full-screen sheet covers the page, so the page behind it cannot take focus.
    await page.waitForFunction(() => !!document.getElementById("main-content")!.closest("[inert]"), undefined, { timeout: 2000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("main-content")!.closest("[inert]"), undefined, { timeout: 2000 });
    await page.keyboard.press("Meta+j");
    await page.emulateMedia({ forcedColors: "active" });
    expect(await page.locator(".pc-aurora__glow").evaluate(el => getComputedStyle(el).display)).toBe("none");
  } finally { await browser.close(); }
}, 20_000);

browserTest("assistant_plus_menu_offers_only_what_works_and_the_sheet_never_depends_on_an_opacity_transition", async () => {
  const built = await build();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, built);
    await openSheet(page);
    // A stalled animation clock (a background WebKit window) must not leave the sheet invisible: no opacity transition.
    const sheet = await page.locator(".pc-aurora").evaluate(el => ({ opacity: getComputedStyle(el).opacity, property: getComputedStyle(el).transitionProperty }));
    expect(sheet.opacity).toBe("1");
    expect(sheet.property).not.toContain("opacity");
    // The decorative glow is nonmodal: page content outside the column stays clickable.
    expect(await page.locator('.pc-aurora').evaluate(el => {
      const box = el.getBoundingClientRect();
      return !!document.elementFromPoint(box.right - 20, box.bottom - 30)?.closest('.pc-aurora-layer');
    })).toBe(false);
    // Before any conversation the menu offers only the context choice.
    const plus = page.getByRole("button", { name: "Conversation options" });
    await plus.click();
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Change context"]);
    await focused(page, '[role="menuitem"]');
    await page.keyboard.press("Escape");
    await focused(page, '[aria-label="Conversation options"]');
    expect(await page.locator(".pc-aurora").getAttribute("data-state")).toBe("open"); // Escape closed the menu only
    await page.getByRole("button", { name: "What needs me today?" }).click();
    await page.getByRole("log", { name: "Conversation" }).getByText("Three tasks need you.").waitFor();
    await plus.click();
    await focused(page, '[role="menuitem"]');
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["New conversation", "Change context"]);
    await page.getByRole("menuitem", { name: "New conversation" }).click();
    await focused(page, '[aria-label="Conversation options"]'); // focus is not dropped
    await expect(page.getByRole("log", { name: "Conversation" }).getByText("Three tasks need you.").count()).resolves.toBe(0);
    // Tabbing out of the menu closes it; while an answer is pending the disabled New conversation item is not offered.
    await plus.click();
    await focused(page, '[role="menuitem"]');
    await page.keyboard.press("Tab");
    await page.getByRole("menu").waitFor({ state: "detached", timeout: 2000 });
    // Closing the sheet with the menu open closes the menu too: it is not open when the sheet comes back.
    await plus.click();
    await focused(page, '[role="menuitem"]');
    await page.keyboard.press("Meta+j");
    await page.waitForFunction(() => document.querySelector(".pc-aurora")?.getAttribute("data-state") === "closed", undefined, { timeout: 2000 });
    // Checked while the sheet is closed, before reopening moves focus (which would close the menu by itself).
    await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 0, undefined, { timeout: 2000 });
    await page.keyboard.press("Meta+j");
    await focused(page, 'input[aria-label="Ask pacer"]');
    expect(await page.evaluate(() => document.querySelectorAll('[role="menu"]').length)).toBe(0);
    // Forced colors keep a visible focus indicator on the composer row.
    await page.emulateMedia({ forcedColors: "active" });
    await page.getByLabel("Ask pacer").focus();
    expect(await page.locator(".pc-aurora-composer").evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
    await page.emulateMedia({ forcedColors: "none" });
    // The chips stay above the input, and the composer's controls are 32px as on the board.
    await page.getByRole("button", { name: "Summarise today’s dispatch" }).waitFor();
    const sizes = await page.evaluate(() => ({ tool: document.querySelector(".pc-aurora-tool")!.getBoundingClientRect().width, send: document.querySelector(".pc-aurora-send")!.getBoundingClientRect().width }));
    expect(sizes).toEqual({ tool: 32, send: 32 });
  } finally { await browser.close(); }
}, 30_000);

webkitTest("assistant_sheet_is_drawn_in_webkit_with_the_desktop_frame_and_the_launcher_rises_above_it", async () => {
  const built = await build();
  const browser = await webkit.launch();
  try {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, reducedMotion });
      await open(page, built);
      await page.evaluate(() => document.documentElement.setAttribute("data-pacer-desktop", ""));
      await openSheet(page);
      const probe = await page.evaluate(() => {
        const sheet = document.querySelector(".pc-aurora")!, input = document.querySelector('input[aria-label="Ask pacer"]')!.getBoundingClientRect(), pill = document.querySelector(".pc-aurora-launcher")!.getBoundingClientRect();
        const hit = document.elementFromPoint(input.left + input.width / 2, input.top + input.height / 2);
        return { opacity: getComputedStyle(sheet).opacity, drawn: !!hit && sheet.contains(hit), inputBottom: input.bottom, pillBottom: pill.bottom, sheetTop: sheet.getBoundingClientRect().top, viewport: innerHeight };
      });
      expect(probe.opacity).toBe("1");
      expect(probe.drawn).toBe(true);
      expect(probe.inputBottom).toBeLessThanOrEqual(probe.viewport);
      expect(probe.pillBottom).toBeLessThanOrEqual(probe.sheetTop); // the launcher sits above the open sheet
      await page.close();
    }
  } finally { await browser.close(); }
}, 40_000);

webkitTest("assistant_plus_menu_items_work_with_the_mouse_in_webkit", async () => {
  const built = await build();
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await open(page, built);
    await openSheet(page);
    await page.getByRole("button", { name: "Conversation options" }).click();
    // WebKit does not focus a clicked button; the click must still reach the item.
    await page.getByRole("menuitem", { name: "Change context" }).click();
    await page.getByRole("listbox").waitFor({ timeout: 2000 });
    await page.getByRole("option").first().click();
    // New conversation by mouse once a conversation exists.
    await page.getByRole("button", { name: "What needs me today?" }).click();
    await page.getByRole("log", { name: "Conversation" }).getByText("Three tasks need you.").waitFor();
    await page.getByRole("button", { name: "Conversation options" }).click();
    await page.getByRole("menuitem", { name: "New conversation" }).click();
    await expect(page.getByRole("log", { name: "Conversation" }).getByText("Three tasks need you.").count()).resolves.toBe(0);
  } finally { await browser.close(); }
}, 30_000);

browserTest("unconfigured entry offers explicit account setup without a fade mask and focuses setup", async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, await build(), "?unconfigured");
    const pill = page.getByRole("button", { name: "Open assistant", exact: true });
    await pill.waitFor(); await pill.focus(); await page.keyboard.press("Meta+j");
    const use = page.getByRole("button", { name: "Use Local model", exact: true });
    await use.waitFor(); await focused(page, '[data-assistant-setup]');
    expect(await page.getByRole('heading', { name: 'Choose where the assistant runs', level: 2 }).count()).toBe(1);
    expect(await page.locator('.pc-assistant-setup .pc-agent-mark').count()).toBe(2);
    expect(await page.locator(".pc-aurora__log").evaluate(el => getComputedStyle(el).maskImage)).toBe("none");
    expect(await page.evaluate(() => (window as any).settingsCalls)).toEqual([]);
    await use.click(); await focused(page, 'input[aria-label="Ask pacer"]');
    expect(await page.evaluate(() => (window as any).settingsCalls)).toEqual([{ account: "localmodel", runner: null, expect_rev: 4 }]);
  } finally { await browser.close(); }
}, 20_000);

browserTest("hidden button retains shortcut and configured refusal shows reason and hint", async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("pacer.assistant.preferences", JSON.stringify({ showButton: false, stillAurora: true })));
    await open(page, await build());
    await page.waitForSelector(".pc-aurora", { state: "attached" });
    expect(await page.locator(".pc-aurora-launcher").count()).toBe(0);
    await page.evaluate(() => { (window as any).assistantStatus = { available: false, configured: true, reason: "No capacity left.", hint: "Try tomorrow." }; });
    await page.keyboard.press("Meta+j");
    await page.getByText("No capacity left. Try tomorrow.", { exact: true }).waitFor();
    expect(await page.getByLabel("Ask pacer").isDisabled()).toBe(true);
    await focused(page, '[data-assistant-refusal]');
    expect(await page.locator(".pc-aurora__log").evaluate(el => getComputedStyle(el).maskImage)).toBe("none");
  } finally { await browser.close(); }
}, 20_000);

browserTest("pill stays 18px above the status bar or resized dock and exposes only measured dock height", async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await open(page, await build());
    await page.getByRole("button", { name: "Open assistant", exact: true }).waitFor();
    const bodyDoesNotScroll = async () => {
      const body = await page.locator('.pc-body').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
      expect(body.top).toBe(0);
      expect(body.height).toBe(body.client);
    };
    const geometry = () => page.evaluate(() => {
      const pill = document.querySelector('.pc-aurora-launcher')!.getBoundingClientRect();
      const edge = (document.querySelector('.pc-dock__panel') ?? document.querySelector('.pc-statusbar'))!.getBoundingClientRect();
      return { gap: edge.top - pill.bottom, height: pill.height, dockHeight: getComputedStyle(document.querySelector('.pc-app')!).getPropertyValue('--pc-dock-height') };
    });
    expect((await geometry()).gap).toBe(18);
    await bodyDoesNotScroll();
    expect((await geometry()).height).toBe(40);
    expect((await geometry()).dockHeight).toBe('0px');
    await page.keyboard.press('Control+Backquote');
    await page.locator('.pc-dock__panel').waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.pc-app')!).getPropertyValue('--pc-dock-height') !== '0px');
    expect((await geometry()).gap).toBe(18);
    await bodyDoesNotScroll();
    await page.keyboard.press('Meta+j');
    await focused(page, 'input[aria-label="Ask pacer"]');
    await bodyDoesNotScroll();
    const openGeometry = await page.evaluate(() => {
      const pill = document.querySelector('.pc-aurora-launcher')!.getBoundingClientRect();
      return { top: pill.top, bottom: pill.bottom, sheetTop: document.querySelector('.pc-aurora')!.getBoundingClientRect().top, frameTop: document.querySelector('.pc-body')!.getBoundingClientRect().top };
    });
    expect(openGeometry.top).toBeGreaterThanOrEqual(openGeometry.frameTop + 36 + 8);
    expect(openGeometry.bottom).toBeLessThanOrEqual(openGeometry.sheetTop);
    await page.keyboard.press('Meta+j');
    await bodyDoesNotScroll();
    // Replacing the dock while it remains open must move the observer to the new node.
    await page.locator('.pc-dock__panel').evaluate(el => { (window as any).originalDock = el; el.replaceWith(el.cloneNode(true)); });
    await page.locator('.pc-dock__panel').evaluate(el => { (el as HTMLElement).style.flex = 'none'; (el as HTMLElement).style.height = '220px'; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.pc-app')!).getPropertyValue('--pc-dock-height') === '220px');
    expect((await geometry()).gap).toBe(18);
    await bodyDoesNotScroll();
    await page.locator('.pc-dock__panel').evaluate(el => el.replaceWith((window as any).originalDock));
    await page.keyboard.press('Control+Backquote');
    await page.locator('.pc-dock__panel').waitFor({ state: 'detached' });
    expect((await geometry()).dockHeight).toBe('0px');
    expect((await geometry()).gap).toBe(18);
    await bodyDoesNotScroll();
  } finally { await browser.close(); }
}, 20_000);

browserTest("Still aurora suppresses generating animation with normal system motion", async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: "no-preference" });
    await page.addInitScript(() => localStorage.setItem("pacer.assistant.preferences", JSON.stringify({ stillAurora: true })));
    await open(page, await build()); await openSheet(page);
    await page.keyboard.type("how is the budget"); await page.keyboard.press("Enter");
    await page.getByText("Thinking…").first().waitFor();
    expect((await animating(page)).every(name => name === "none")).toBe(true);
  } finally { await browser.close(); }
}, 20_000);

browserTest("setup selection with the dock open never scrolls the frame body", async () => {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    for (const height of [700, 900]) {
      const page = await browser.newPage({ viewport: { width: 1440, height } });
      await open(page, await build(), "?unconfigured");
      await page.getByRole('button', { name: 'Open assistant', exact: true }).waitFor();
      await page.keyboard.press('Control+Backquote');
      await page.locator('.pc-dock').waitFor();
      // The existing rail overflows the frame at 700px even without the assistant.
      const baselineHeight = await page.locator('.pc-body').evaluate(el => el.scrollHeight);
      if (height === 900) expect(baselineHeight).toBe(await page.locator('.pc-body').evaluate(el => el.clientHeight));
      const assertBody = async () => {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const body = await page.locator('.pc-body').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
        expect(body.top).toBe(0);
        expect(body.height).toBe(baselineHeight);
      };
      await assertBody();
      await page.keyboard.press('Meta+j');
      await focused(page, '[data-assistant-setup]');
      const heading = (await page.getByRole('heading', {name: 'Choose where the assistant runs'}).boundingBox())!;
      const log = (await page.locator('.pc-aurora__log').boundingBox())!;
      expect(heading.y).toBeGreaterThanOrEqual(log.y);
      expect(heading.y + heading.height).toBeLessThanOrEqual(log.y + log.height);
      await assertBody();
      const choose = page.getByRole('button', { name: 'Use Local model', exact: true });
      // Reveal the row by scrolling the log, as a person must in a short window.
      // Playwright's generic scrollIntoView also scrolls the pre-existing rail overflow.
      await choose.evaluate(el => {
        const log = el.closest('.pc-aurora__log')!;
        log.scrollTop += Math.max(0, el.getBoundingClientRect().bottom - log.getBoundingClientRect().bottom);
      });
      await assertBody();
      await choose.click();
      await focused(page, 'input[aria-label="Ask pacer"]');
      await assertBody();
      await page.keyboard.press('Escape');
      await assertBody();
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

browserTest("open assistant pill stays below top bar and measured session header with a dock", async () => {
  const browser = await chromium.launch({executablePath:browserPath!,headless:true});
  try {
    for (const height of [700,900]) for (const headerClass of ["pc-session-bar", "pc-page-header"]) {
      const page = await browser.newPage({viewport:{width:1440,height}});
      await open(page,await build());
      await page.keyboard.press("Control+Backquote");
      await page.locator(".pc-dock").waitFor();
      // Model a late-mounted session header in the real shell, including a height change.
      await page.locator("#main-content").evaluate((el,cls)=>el.insertAdjacentHTML("afterbegin",`<header class="${cls} pc-test-header" style="height:80px"><button>Take over</button></header>`),headerClass);
      await openSheet(page);
      for (const headerHeight of [80,120]) {
        await page.locator(".pc-test-header").evaluate((el,height)=>{(el as HTMLElement).style.height=`${height}px`;},headerHeight);
        await page.waitForFunction(()=>{
          const pill=document.querySelector('.pc-aurora-launcher--open')!.getBoundingClientRect();
          const header=document.querySelector('.pc-test-header')!.getBoundingClientRect();
          const top=document.querySelector('.pc-topbar')!.getBoundingClientRect();
          return pill.top >= Math.max(header.bottom,top.bottom)+7;
        });
      }
      const inset = await page.evaluate(()=>document.querySelector(".pc-aurora")!.getBoundingClientRect().bottom-document.querySelector(".pc-aurora__column")!.getBoundingClientRect().bottom);
      expect(inset).toBeCloseTo(18,2);
      await page.close();
    }
  } finally {await browser.close();}
},30000);
