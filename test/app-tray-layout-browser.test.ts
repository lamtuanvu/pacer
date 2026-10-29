import { expect, test } from "bun:test";
import { chromium } from "playwright-core";

const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);

browserTest("tray footer stays pinned under the scrolling 560px body and More floats above it", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 560 } });
    await page.setContent('<div class="tray"><main class="tray-main"><header class="tray-planner">Planner</header><section class="tray-clear">Nothing needs you</section></main><div class="tray-actions"><nav class="tray-footer">Actions</nav></div></div>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    await page.locator(".tray-main").evaluate(node => {
      for (let i = 0; i < 30; i++) {
        const row = document.createElement("section");
        row.className = "tray-clear"; row.textContent = "A task";
        node.append(row);
      }
    });
    const panel = page.locator(".tray"), footer = page.locator(".tray-footer");
    expect(await panel.evaluate(node => node.getBoundingClientRect().height)).toBe(560);
    const footerTop = (await footer.boundingBox())!.y;
    await page.locator(".tray-main").evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect((await footer.boundingBox())!.y).toBe(footerTop);
    await page.locator(".tray-actions").evaluate(node => {
      const menu = document.createElement("nav");
      menu.className = "tray-menu"; menu.textContent = "Strategy · Settings · Quit pacer";
      node.append(menu);
    });
    const menu = (await page.locator(".tray-menu").boundingBox())!;
    expect(await panel.evaluate(node => node.getBoundingClientRect().height)).toBe(560);
    expect((await footer.boundingBox())!.y).toBe(footerTop);
    expect(menu.y + menu.height).toBeLessThan(footerTop);
    expect(menu.width).toBe(236);
    expect(menu.x + menu.width).toBeLessThanOrEqual(340);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    expect(parseFloat(await page.evaluate(() => getComputedStyle(document.body).borderTopLeftRadius))).toBeGreaterThan(0);
  } finally { await browser.close(); }
}, 20000);

browserTest("tray board controls, shortcuts and paused Resume call real handlers", async () => {
  const build = await Bun.build({ entrypoints: ["tray-fixture"], target: "browser", plugins: [{
    name: "tray-fixture", setup(builder) {
      builder.onResolve({ filter: /^tray-fixture$/ }, () => ({ path: "tray-fixture", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "tsx", resolveDir: process.cwd(), contents: `/** @jsxImportSource preact */
        import { render } from "preact";
        import { Tray } from "./app/src/tray/Tray";
        import fixture from "./test/fixtures/ui/snapshot.json";
        window.calls = [];
        const api = { call: async (...args) => { window.calls.push(args); return {}; } };
        const ipc = { desktop: true, open: async route => { window.calls.push(["open",route]); }, resize: async height => { window.calls.push(["resize",height]); }, hide: async () => { window.calls.push(["hide"]); }, quit: async () => { window.calls.push(["quit"]); } };
        window.draw = (paused = false, desktop = true, clear = false, loading = false) => render(<Tray snapshot={loading ? null : {...fixture, executors:Array.from({length:6},(_,i)=>({...fixture.executors[0],id:"executor-"+i,usedPct:100,state:"ready",enabled:true,slots:{used:0,max:2}})), strategies:[{name:"default",active:true},"weekend"], attention:clear ? [] : fixture.attention, pause:paused ? {until:null,by:"app",reason:null} : null}} api={api} ipc={{...ipc,desktop}} />, document.getElementById("app"));
        window.draw();
      ` }));
    }
  }] });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 560 } });
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    await page.evaluate(async source => { await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" }))); }, await build.outputs[0]!.text());
    const calls = () => page.evaluate(() => (window as any).calls);
    const footer = (await page.locator(".tray-footer").boundingBox())!;
    expect(footer.x + footer.width).toBeLessThanOrEqual(340);
    for (const node of await page.locator(".tray-footer .pc-btn").all()) {
      const box = (await node.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(340);
    }
    await page.getByRole("button", { name: "More", exact: true }).click();
    expect(await page.getByRole("button", { name: /Strategy/ }).evaluate(node=>node===document.activeElement)).toBe(true);
    for (const key of ["End","ArrowDown","Home","ArrowUp"]) {
      await page.keyboard.press(key);
      expect(await page.locator("#tray-menu").evaluate(node=>node.contains(document.activeElement))).toBe(true);
    }
    const popup = (await page.locator("#tray-menu").boundingBox())!;
    const minimum = await page.locator("#tray-menu").evaluate(node=>node.getBoundingClientRect().height+parseFloat(getComputedStyle(node).bottom));
    expect(popup.y).toBeGreaterThanOrEqual(0);
    expect((await calls()).filter((call:any[])=>call[0]==="resize").at(-1)[1]).toBeGreaterThanOrEqual(Math.min(560,minimum));
    const executorBoxes = await page.locator(".tray-executor").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
    expect(new Set(executorBoxes).size).toBeGreaterThan(1);
    for(const node of await page.locator(".tray-executor").all()) expect((await node.boundingBox())!.x+(await node.boundingBox())!.width).toBeLessThanOrEqual(340);
    expect(await page.getByRole("button", { name: /Strategy/ }).textContent()).toContain("default");
    expect(await page.getByRole("link", { name: /Settings/ }).getAttribute("href")).toBe("/app/#/settings");
    expect(await page.getByRole("button", { name: /Quit pacer/ }).count()).toBe(1);
    expect(await page.getByText(/Open at login|Launch at login/).count()).toBe(0);
    await page.getByRole("button", { name: /Strategy/ }).click();
    expect(await page.locator("#tray-strategies [aria-pressed=true]").count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("navigation", { name: "More actions" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "More", exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
    expect(await calls()).not.toContainEqual(["hide"]);
    await page.keyboard.press("Escape");
    expect(await calls()).toContainEqual(["hide"]);
    await page.getByRole("button", {name:"More",exact:true}).click();
    await page.locator(".tray-planner").click();
    expect(await page.locator("#tray-menu").count()).toBe(0);
    await page.keyboard.press("Meta+n");
    await page.keyboard.press("Meta+o");
    await page.keyboard.press("Meta+,");
    await page.keyboard.press("Meta+q");
    expect(await calls()).toContainEqual(["open", "/?new=task"]);
    expect(await calls()).toContainEqual(["open", "/"]);
    expect(await calls()).toContainEqual(["open", "/settings"]);
    expect(await calls()).toContainEqual(["quit"]);
    await page.evaluate(() => (window as any).draw(true));
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    expect(await calls()).toContainEqual(["delegation.resume", {}]);
    expect(await page.locator(".tray-mode").textContent()).toBe("Paused");
    const modeBox = (await page.locator(".tray-mode").boundingBox())!;
    expect(modeBox.x + modeBox.width).toBeLessThanOrEqual(326);
    expect(await page.getByRole("button", { name: "Resume delegation", exact: true }).locator("path").getAttribute("d")).toBe("M8 5l11 7-11 7z");
    await page.evaluate(() => (window as any).draw(false, false));
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.evaluate(()=>{(window as any).calls=[];});
    await page.keyboard.press("Meta+q");
    expect(await calls()).not.toContainEqual(["quit"]);
    expect(await page.getByRole("button", { name: /Quit pacer/ }).count()).toBe(0);
    expect(await page.locator(".tray-menu-divider").count()).toBe(0);
    expect(await page.locator(".tray").textContent()).not.toMatch(/[⏸▶⋯⏳]/);

    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.evaluate(() => (window as any).draw(false, true, false, true));
    const closedHeight = (await page.locator(".tray").boundingBox())!.height;
    await page.getByRole("button", { name: "More", exact: true }).click();
    const shortMenu = (await page.locator("#tray-menu").boundingBox())!;
    const shortTray = (await page.locator(".tray").boundingBox())!;
    const requested = (await calls()).filter((call: any[]) => call[0] === "resize").at(-1)[1];
    expect(shortMenu.y).toBeGreaterThanOrEqual(shortTray.y);
    expect(shortMenu.y + shortMenu.height).toBeLessThanOrEqual(shortTray.y + shortTray.height);
    expect(requested).toBeGreaterThanOrEqual(shortTray.height);
    expect(requested).toBeLessThan(396);
    await page.getByRole("button", { name: "More", exact: true }).click();
    expect((await page.locator(".tray").boundingBox())!.height).toBe(closedHeight);

    if (process.env.PACER_TRAY_SCREENSHOTS) {
      for (const state of ["busy", "clear", "paused", "dark"]) {
        await page.evaluate(state => {
          document.documentElement.dataset.theme = state === "dark" ? "dark" : "light";
          (window as any).draw(state === "paused", true, state === "clear");
        }, state);
        if (await page.getByRole("navigation", { name: "More actions" }).count()) await page.getByRole("button", { name: "More", exact: true }).click();
        if (state === "paused") await page.getByRole("button", { name: "More", exact: true }).click();
        await page.screenshot({ path: `${process.env.PACER_TRAY_SCREENSHOTS}/${state}.png` });
      }
    }
  } finally { await browser.close(); }
}, 20000);

browserTest("xs buttons share a compact minimum height in default and compact density", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent('<button class="pc-btn pc-btn--xs pc-btn--normal">Default</button><button class="pc-btn pc-btn--xs pc-btn--compact">Compact</button>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css"].map(path => Bun.file(path).text()))).join("\n") });
    const heights = await page.locator("button").evaluateAll(nodes => nodes.map(node => ({
      actual: parseFloat(getComputedStyle(node).minHeight),
      expected: parseFloat(getComputedStyle(node).getPropertyValue("--control-compact")),
    })));
    for (const height of heights) expect(height.actual).toBe(height.expected);
  } finally { await browser.close(); }
}, 20000);
