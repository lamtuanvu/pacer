import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { buildApp } from "../app/build";

// Opt-in against the CT-11 sandbox, never a user's service. The URL is a one-use harness login.
const login = process.env.PACER_FRAME_TEST_URL;
const browserTest = test.skipIf(!login || !process.env.PACER_TEST_BROWSER);
browserTest("all routed page frames and the resizable terminal match the boards", async () => {
  const files = new Map((await buildApp()).map(file => [file.path, file]));
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  const output = process.env.PACER_FRAME_SCREENSHOTS;
  if (output) mkdirSync(output, { recursive: true });
  try {
    const context = await browser.newContext();
    await context.route("**/app/**", route => {
      const path = new URL(route.request().url()).pathname.slice(5);
      const file = files.get(path);
      return file && path !== "index.html" ? route.fulfill({ contentType: file.type, body: file.text }) : route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", error => console.error("Browser error:", error.message));
    await page.goto(login!);
    await page.locator(".pc-topbar").waitFor();
    const base = new URL("/app/", login!).href;
    const currentRepo = await page.evaluate(async () => (await (await fetch("/v3/snapshot")).json()).snapshot.repos[0] as {key:string;path:string});
    for (const width of [1440, 1920]) for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 1080 });
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(() => { localStorage.removeItem("pacer.panel.terminal"); localStorage.removeItem("pacer.terminal.height"); });
      for (const route of ["dispatch", "insights", "tasks", "tasks/new", "needs-you", "terminal", "settings", "settings/executors", "settings/accounts", "settings/dispatcher", "settings/planner", "settings/machine", "settings/plugins", "settings/app", "settings/diagnostics", "settings/add-executor"]) {
        await page.goto(`${base}#/${route}`);
        await page.locator("#main-content h1").first().waitFor();
        expect(await page.locator("h1").count(), route).toBe(1);
        await page.evaluate(() => document.documentElement.setAttribute("data-pacer-native-titlebar", ""));
        const geometry = await page.locator("#main-content").evaluate(main => {
          const title = main.querySelector("h1")!, frame = main.getBoundingClientRect(), heading = title.getBoundingClientRect();
          const container = main.querySelector<HTMLElement>(".pc-page")!, css = getComputedStyle(container);
          const top = document.querySelector(".pc-topbar")!;
          const content = container.getBoundingClientRect();
          return { left: heading.left - frame.left, top: heading.top - frame.top, right: frame.right - content.right + parseFloat(css.paddingRight), padding: css.padding,
            type: [getComputedStyle(title).fontSize, getComputedStyle(title).lineHeight, getComputedStyle(title).fontWeight], topHeight: top.getBoundingClientRect().height, topPadding: getComputedStyle(top).padding, searchRadius: getComputedStyle(top.querySelector(".pc-command-trigger")!).borderRadius, searchWidth: top.querySelector(".pc-command-trigger")!.getBoundingClientRect().width,
            toggles: [...top.querySelectorAll<HTMLButtonElement>(".pc-layout-toggles button")].map(button => ({ w: button.getBoundingClientRect().width, h: button.getBoundingClientRect().height, disabled: button.disabled, title: button.title })),
            search: top.querySelector(".pc-command-trigger")?.getBoundingClientRect().height, chip: top.querySelector(".pc-planner")?.getBoundingClientRect().height,
            newTask: top.querySelector(".pc-topbar__new")?.getBoundingClientRect().height };
        });
        expect(geometry.left, route).toBe(32);
        expect(geometry.top, route).toBe(24);
        expect(geometry.right, route).toBe(32);
        expect(geometry.padding, route).toBe("24px 32px 40px");
        expect(geometry.type, route).toEqual(["28px", "34px", "650"]);
        expect(geometry.topHeight).toBe(36);
        expect(geometry.topPadding).toBe("0px 10px 0px 84px");
        expect(geometry.searchWidth).toBe(420);
        expect(geometry.searchRadius).toBe("6px");
        expect(geometry.search).toBe(26);
        expect(geometry.chip).toBe(24);
        expect(geometry.newTask).toBe(26);
        expect(geometry.toggles).toHaveLength(3);
        for (const toggle of geometry.toggles) { expect([toggle.w, toggle.h]).toEqual([28, 28]); if (toggle.disabled) expect(toggle.title).toContain("no "); }
        await page.waitForTimeout(250);
        if (output) await page.screenshot({ path: `${output}/${route.replaceAll("/", "-")}-${width}-${theme}.png` });
      }
      await page.goto(`${base}#/dispatch?repo=${encodeURIComponent(currentRepo.key)}`);
      await page.getByRole("button", { name: "Toggle terminal panel (Ctrl+`)" }).click();
      const panel = page.getByRole("region", { name: "Terminal panel", exact: true });
      await panel.waitFor();
      const sash = page.getByRole("separator", { name: "Resize terminal panel", exact: true });
      expect(await sash.evaluate(e => e.getBoundingClientRect().height)).toBe(6);
      expect(Math.abs((await panel.boundingBox())!.height - 260)).toBeLessThan(2);
      expect(await panel.locator(".pc-workspace-terminal__header").evaluate(e => ({height:e.getBoundingClientRect().height,padding:getComputedStyle(e).padding}))).toEqual({height:30,padding:"0px 4px"});
      expect(await panel.getByRole("button", {name:"New terminal",exact:true}).evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,radius:getComputedStyle(e).borderRadius}))).toEqual({width:24,height:24,radius:"6px"});
      for (const label of ["New terminal in…", "Maximize panel", "Hide panel (Ctrl+`)"]) expect(await panel.getByRole("button", {name:label,exact:true}).locator("svg").count()).toBe(1);
      const restoreHeight = (await panel.boundingBox())!.height;
      await panel.getByRole("button", {name:"Maximize panel",exact:true}).click();
      expect(Math.abs((await panel.boundingBox())!.height - (await page.locator(".pc-app").evaluate(app => app.clientHeight - parseFloat(getComputedStyle(app).paddingBottom) - 36)))).toBeLessThan(2);
      await panel.getByRole("button", {name:"Restore panel",exact:true}).click();
      expect(Math.abs((await panel.boundingBox())!.height - restoreHeight)).toBeLessThan(2);
      await panel.getByText("Loading terminals…", {exact:true}).waitFor({state:"detached"});
      const tabCount = await panel.getByRole("tab").count();
      await panel.getByRole("button", { name: "New terminal", exact: true }).click();
      await page.waitForFunction(count => document.querySelectorAll("#pc-terminal-dock [role=tab]").length === count + 1, tabCount, { timeout: 5000 }).catch(async error => { console.error(await panel.innerText()); throw error; });
      await panel.locator('.pc-terminal-view[data-session-control="true"]').first().waitFor({ timeout: 5000 }).catch(async error => { console.error(await panel.innerText()); if (output) await page.screenshot({path: `${output}/terminal-error.png`}); throw error; });
      expect(await panel.getByRole("tab").last().getAttribute("title")).not.toMatch(/(?:\/Users\/|\/home\/|t-\d{8})/);
      expect(await panel.getByRole("search").count()).toBe(0);
      const body = await panel.locator(".pc-terminal-pane").first().evaluate(e => { const css = getComputedStyle(e); return [css.padding, css.fontSize, css.lineHeight]; });
      expect(body).toEqual(["10px 14px", "12px", "19px"]);
      const rowHeight = await panel.locator(".xterm-rows > div").first().evaluate(row => row.getBoundingClientRect().height);
      expect(Math.abs(rowHeight - 19)).toBeLessThanOrEqual(1);
      await page.waitForFunction(() => { const screen = document.querySelector("#pc-terminal-dock .xterm-screen"), pane = document.querySelector("#pc-terminal-dock .pc-terminal-pane"); return !!screen && !!pane && screen.getBoundingClientRect().height <= pane.getBoundingClientRect().height; });
      const before = await panel.locator(".xterm-screen").first().boundingBox();
      const box = (await sash.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 3);
      await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 100, { steps: 12 }); await page.mouse.up();
      expect(Number(await sash.getAttribute("aria-valuenow"))).toBeGreaterThan(350);
      expect(Number.isInteger(Number(await sash.getAttribute("aria-valuenow")))).toBe(true);
      await page.waitForTimeout(250);
      expect((await panel.locator(".xterm-screen").first().boundingBox())!.height).toBeGreaterThan(before!.height);
      await sash.focus(); await page.keyboard.press("Home"); expect(await sash.getAttribute("aria-valuenow")).toBe("120");
      await page.keyboard.press("ArrowUp"); expect(await sash.getAttribute("aria-valuenow")).toBe("136");
      await page.keyboard.press("End"); expect(await sash.getAttribute("aria-valuenow")).toBe(await sash.getAttribute("aria-valuemax"));
      await sash.dblclick(); expect(await sash.getAttribute("aria-valuenow")).toBe("260");
      await sash.focus(); await page.keyboard.press("ArrowUp");
      await page.reload(); await panel.waitFor(); expect(await sash.getAttribute("aria-valuenow")).toBe("276");
      await panel.getByRole("button", { name: "Find (⌘F)" }).click(); await panel.getByRole("textbox", { name: "Search terminal output" }).waitFor();
      await page.keyboard.press("Escape"); await panel.getByRole("search").waitFor({state:"detached"});
      const original = await panel.getByRole("tab").last().textContent();
      await panel.getByRole("tab").last().dblclick();
      await panel.getByRole("textbox", {name:"Terminal name"}).fill("Canceled rename");
      await panel.getByRole("textbox", {name:"Terminal name"}).press("Escape");
      expect(await panel.getByRole("tab").last().textContent()).toBe(original);
      await panel.getByRole("tab").last().dblclick();
      const name = `Frame test ${width}-${theme}-${Date.now()}`;
      const rename = panel.getByRole("textbox", { name: "Terminal name" }); await rename.fill(name); await rename.press("Enter");
      await panel.getByRole("tab", { name, exact: true }).waitFor();
      await panel.getByRole("button", { name: "Split terminal (⌘\\)" }).click();
      await panel.getByRole("separator", { name: "Resize terminal split" }).waitFor();
      expect(await panel.locator(".pc-workspace-terminal__pane").count()).toBe(2);
      for (const [index, side] of ["PRIMARY", "SECONDARY"].entries()) {
        const pane = panel.locator(".pc-workspace-terminal__pane").nth(index);
        await pane.locator('.pc-terminal-view[data-session-control="true"]').waitFor();
        await pane.locator(".xterm-helper-textarea").focus();
        await page.keyboard.type(`printf 'FRAME_%s\\n' '${side}_${width}_${theme}'`);
        await page.keyboard.press("Enter");
        await pane.locator(".xterm-rows").filter({hasText:`FRAME_${side}_${width}_${theme}`}).waitFor();
      }
      const splitSash = panel.getByRole("separator", {name:"Resize terminal split"});
      expect(await splitSash.evaluate(e=>e.getBoundingClientRect().width)).toBe(6);
      await splitSash.focus(); await page.keyboard.press("ArrowRight");
      expect(Number(await splitSash.getAttribute("aria-valuenow"))).toBe(55);
      const second = panel.locator(".pc-workspace-terminal__pane").nth(1);
      await second.locator(".xterm-helper-textarea").focus(); await page.keyboard.press("Meta+f");
      await second.getByRole("textbox", {name:"Search terminal output"}).waitFor();
      expect(await panel.locator(".pc-workspace-terminal__pane").first().getByRole("search").count()).toBe(0);
      await page.keyboard.press("Escape"); await second.getByRole("search").waitFor({state:"detached"});
      if (output) await page.screenshot({ path: `${output}/terminal-panel-split-${width}-${theme}.png` });
      await panel.getByRole("button", { name: "Hide panel (Ctrl+`)" }).click();
      await page.goto(`${base}#/terminal`);
      await page.locator('.pc-terminal-view[data-session-control="true"]').first().waitFor();
      if (output) await page.screenshot({path:`${output}/terminal-${width}-${theme}.png`});
      // Close this iteration's real PTYs so repeated runs cannot hit the service's live-shell limit.
      while (await page.getByRole("tab").count()) {
        const count = await page.getByRole("tab").count();
        await page.getByRole("button", {name:"Kill terminal",exact:true}).click();
        await page.getByRole("button", {name:"Stop and close",exact:true}).click();
        await page.waitForFunction(previous => document.querySelectorAll('[role="tab"]').length === previous - 1, count);
      }
    }
  } finally { await browser.close(); }
}, 180_000);
