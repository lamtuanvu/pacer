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
    expect(await panel.evaluate(node => node.getBoundingClientRect().height)).toBe(558); // 560 px popover minus its 1 px border
    const footerTop = (await footer.boundingBox())!.y;
    await page.locator(".tray-main").evaluate(node => { node.scrollTop = node.scrollHeight; });
    expect((await footer.boundingBox())!.y).toBe(footerTop);
    await page.locator(".tray-actions").evaluate(node => {
      const menu = document.createElement("nav");
      menu.className = "tray-menu"; menu.textContent = "Strategy · Settings · Quit pacer";
      node.append(menu);
    });
    const menu = (await page.locator(".tray-menu").boundingBox())!;
    expect(await panel.evaluate(node => node.getBoundingClientRect().height)).toBe(558); // 560 px popover minus its 1 px border
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
    expect(await calls()).toContainEqual(["open", "/tasks/new"]);
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
    const resizeWindow = async () => {
      const requested = Math.ceil((await calls()).filter((call: any[]) => call[0] === "resize").at(-1)[1]);
      await page.setViewportSize({ width: 340, height: requested });
      return requested;
    };
    await resizeWindow();
    const closedHeight = (await page.locator(".tray").boundingBox())!.height;
    await page.getByRole("button", { name: "More", exact: true }).click();
    await resizeWindow();
    await page.getByRole("button", { name: /Strategy/ }).click();
    const requested = await resizeWindow();
    const shortMenu = (await page.locator("#tray-menu").boundingBox())!;
    const shortTray = (await page.locator(".tray").boundingBox())!;
    expect(await page.locator("#tray-strategies").count()).toBe(1);
    expect(await page.locator("#tray-menu").evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
    expect(shortMenu.y).toBeGreaterThanOrEqual(shortTray.y);
    expect(shortMenu.y + shortMenu.height).toBeLessThanOrEqual(shortTray.y + shortTray.height);
    expect(requested).toBeGreaterThanOrEqual(shortTray.height);
    expect(requested).toBeLessThan(396);
    await page.evaluate(() => (window as any).draw());
    expect(await resizeWindow()).toBe(560);
    await page.evaluate(() => (window as any).draw(false, true, false, true));
    expect(await resizeWindow()).toBe(requested);
    expect(await page.locator("#tray-menu").count()).toBe(1);
    await page.getByRole("button", { name: "More", exact: true }).click();
    const shrunk = await resizeWindow();
    expect(shrunk).toBeLessThan(requested);
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

browserTest("a squeezed planner header drops the planner label whole before the name truncates", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 200 } });
    const header = (pill: string) => `<div class="tray"><main class="tray-main"><section class="tray-planner"><div class="tray-line"><strong>Codex</strong><span class="tray-planner-label-slot"><span class="tray-planner-label-spacer"></span><span class="tray-planner-label">planner</span></span><span class="tray-grow"></span><span class="pc-pill" style="flex:none">${pill}</span><span class="tray-mode">Paused</span></div></section></main></div>`;
    await page.setContent(header("Ahead"));
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    const visible = () => page.evaluate(() => {
      const slot = document.querySelector(".tray-planner-label-slot")!.getBoundingClientRect(), label = document.querySelector(".tray-planner-label")!.getBoundingClientRect();
      return label.top < slot.bottom && label.bottom > slot.top && label.right > slot.left && label.left < slot.right;
    });
    const nameFits = () => page.locator(".tray-line strong").evaluate(node => node.scrollWidth <= node.clientWidth);
    expect(await visible()).toBe(true);
    await page.evaluate(html => { document.body.innerHTML = html; }, header("? Usage unknown · ahead"));
    expect(await visible()).toBe(false);
    expect(await page.locator(".tray-planner-label").evaluate(node => node.getBoundingClientRect().top >= node.parentElement!.getBoundingClientRect().bottom)).toBe(true);
    expect(await nameFits()).toBe(true);
  } finally { await browser.close(); }
}, 20000);

browserTest("an open menu in a tall browser viewport keeps the footer inside the 560px popover", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 700 } });
    await page.setContent('<div class="tray tray--menu-open"><main class="tray-main"><section class="tray-clear">Nothing needs you</section></main><div class="tray-actions"><nav class="tray-footer">Actions</nav><nav class="tray-menu">Strategy · Settings</nav></div></div>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    const body = await page.evaluate(() => { const r = document.body.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
    const footer = (await page.locator(".tray-footer").boundingBox())!;
    expect(body.height).toBeLessThanOrEqual(560);
    expect(footer.y + footer.height).toBeLessThanOrEqual(body.bottom);
  } finally { await browser.close(); }
}, 20000);

browserTest("tall content at the 560px cap keeps the whole footer inside the bordered body", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 560 } });
    await page.setContent('<div class="tray"><main class="tray-main"></main><div class="tray-actions"><nav class="tray-footer">Actions</nav></div></div>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    await page.locator(".tray-main").evaluate(node => { for (let i = 0; i < 40; i++) { const row = document.createElement("section"); row.className = "tray-clear"; row.textContent = "A task"; node.append(row); } });
    const body = await page.evaluate(() => document.body.getBoundingClientRect().bottom - parseFloat(getComputedStyle(document.body).borderBottomWidth));
    const footer = (await page.locator(".tray-footer").boundingBox())!;
    expect(footer.y + footer.height).toBeLessThanOrEqual(body);
  } finally { await browser.close(); }
}, 20000);

browserTest("a medium squeeze empties the planner label slot before the name loses a sub-pixel", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 200 } });
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    for (const pill of ["On pace · ahead", "On pace · ah", "On pace"]) {
      await page.evaluate(pill => { document.body.innerHTML = `<div class="tray"><main class="tray-main"><section class="tray-planner"><div class="tray-line"><strong>Claude Code</strong><span class="tray-planner-label-slot"><span class="tray-planner-label-spacer"></span><span class="tray-planner-label">planner</span></span><span class="tray-grow"></span><span class="pc-pill" style="flex:none">${pill}</span><span class="tray-mode">Paused</span></div></section></main></div>`; }, pill);
      const fit = await page.evaluate(() => {
        const name = document.querySelector(".tray-line strong")!, range = document.createRange(); range.selectNodeContents(name);
        return { box: name.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
      });
      expect(fit.box + 0.01).toBeGreaterThanOrEqual(fit.text);
    }
  } finally { await browser.close(); }
}, 20000);

// Exercise the production markup, compact density and real shared status descriptors.
for (const width of [340, 260]) browserTest(`tray planner name never runs under the status pill at ${width}px`, async () => {
  const build = await Bun.build({ entrypoints: ["tray-header-fixture"], target: "browser", plugins: [{
    name: "tray-header-fixture", setup(builder) {
      builder.onResolve({ filter: /^tray-header-fixture$/ }, () => ({ path: "tray-header-fixture", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "tsx", resolveDir: process.cwd(), contents: `/** @jsxImportSource preact */
        import { render } from "preact";
        import { Tray } from "./app/src/tray/Tray";
        import fixture from "./test/fixtures/ui/snapshot.json";
        const api = { call: async () => ({}) };
        const ipc = { desktop: true, open: async () => {}, resize: async () => {}, hide: async () => {}, quit: async () => {} };
        window.draw = state => render(<Tray snapshot={{...fixture,
          planner: {...fixture.planner, verdict: state === "behind" ? "behind" : state === "clear" ? "on_pace" : "ahead"},
          attention: state === "clear" ? [] : fixture.attention,
          pause: state === "paused" ? {until:null,by:"app",reason:null} : null
        }} api={api} ipc={ipc} />, document.getElementById("app"));
      ` }));
    }
  }] });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 560 } });
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    await page.evaluate(async source => { await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" }))); }, await build.outputs[0]!.text());
    for (const [state, label] of [["busy", "Ahead of pace"], ["behind", "Behind pace"], ["paused", "Ahead of pace"], ["clear", "On pace"]]) {
      await page.evaluate(state => (window as any).draw(state), state);
      const fit = await page.locator(".tray-line").evaluate(node => {
        const name = node.querySelector("strong")!, pill = node.querySelector(".pc-pill")!, mode = node.querySelector(".tray-mode")!;
        const glyph = pill.querySelector(".pc-glyph")!, label = pill.querySelector(".tray-pace-label")!;
        const box = (element: Element) => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width }; };
        const range = document.createRange(); range.selectNodeContents(name);
        return { name:box(name), pill:box(pill), mode:box(mode), glyph:box(glyph), label:box(label),
          textWidth:range.getBoundingClientRect().width, overflow:getComputedStyle(name).textOverflow,
          labelScroll:label.scrollWidth, labelClient:label.clientWidth,
          fullLabel:pill.getAttribute("title"), pillText:pill.textContent, glyphText:glyph.textContent,
          modeTitle:mode.getAttribute("title"), modeText:mode.textContent };
      });
      expect(fit.name.width).toBeGreaterThanOrEqual(64);
      expect(fit.overflow).toBe("ellipsis");
      for (const item of [fit.pill, fit.mode]) {
        expect(item.top).toBeLessThan(fit.name.bottom);
        expect(item.bottom).toBeGreaterThan(fit.name.top);
      }
      expect(fit.name.right).toBeLessThanOrEqual(fit.pill.left);
      expect(fit.pill.right).toBeLessThanOrEqual(fit.mode.left);
      expect(fit.mode.right).toBeLessThanOrEqual(width - 14);
      expect(fit.glyph.width).toBeGreaterThan(0);
      expect(fit.glyph.left).toBeGreaterThanOrEqual(fit.pill.left);
      expect(fit.glyph.right).toBeLessThanOrEqual(fit.pill.right);
      expect(fit.glyphText?.trim().length).toBeGreaterThan(0);
      expect(fit.fullLabel).toBe(label!);
      expect(fit.pillText).toContain(label!);
      expect(fit.modeTitle).toBe(fit.modeText);
      if (width === 340) {
        expect(Math.abs(fit.name.width - fit.textWidth)).toBeLessThan(0.02);
        expect(fit.labelScroll).toBeLessThanOrEqual(fit.labelClient);
      } else {
        expect(fit.name.width).toBeLessThan(fit.textWidth);
        expect(fit.labelScroll).toBeGreaterThan(fit.labelClient);
      }
      if (process.env.PACER_TRAY_SCREENSHOTS) {
        console.log(JSON.stringify({ width, state, ...fit }));
        await page.screenshot({ path: `${process.env.PACER_TRAY_SCREENSHOTS}/header-${width}-${state}.png` });
      }
    }
  } finally { await browser.close(); }
}, 20000);
