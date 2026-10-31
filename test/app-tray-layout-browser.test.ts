import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { buildApp } from "../app/build";
import { trayBoard } from "./fixtures/tray-board";

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

for (const width of [340, 260]) browserTest(`tray board controls stay contained and call real handlers at ${width}px`, async () => {
  const build = await Bun.build({ entrypoints: ["tray-fixture"], target: "browser", plugins: [{
    name: "tray-fixture", setup(builder) {
      builder.onResolve({ filter: /^tray-fixture$/ }, () => ({ path: "tray-fixture", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "tsx", resolveDir: process.cwd(), contents: `/** @jsxImportSource preact */
        import { render } from "preact";
        import { Tray } from "./app/src/tray/Tray";
        import fixture from "./test/fixtures/ui/snapshot.json";
        window.calls = [];
        const api = { call: async (...args) => { window.calls.push(args); return {}; } };
        const ipc = { desktop: true, loginItem: async enabled => { window.calls.push(["login",enabled]); return enabled ?? true; }, open: async route => { window.calls.push(["open",route]); }, resize: async height => { window.calls.push(["resize",height]); }, hide: async () => { window.calls.push(["hide"]); }, quit: async () => { window.calls.push(["quit"]); } };
        window.draw = (paused = false, desktop = true, clear = false, loading = false) => render(<Tray snapshot={loading ? null : {...fixture, executors:Array.from({length:6},(_,i)=>({...fixture.executors[0],id:"executor-"+i,rank:i+1,usedPct:100,state:"ready",enabled:true,slots:{used:0,max:2}})), strategies:[{name:"default",active:true},"weekend"], attention:clear ? [] : fixture.attention, pause:paused ? {until:null,by:"app",reason:null} : null}} api={api} ipc={{...ipc,desktop}} />, document.getElementById("app"));
        window.draw();
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
    const calls = () => page.evaluate(() => (window as any).calls);
    const footer = (await page.locator(".tray-footer").boundingBox())!;
    expect(footer.x + footer.width).toBeLessThanOrEqual(width);
    for (const node of await page.locator(".tray-footer .pc-btn").all()) {
      const box = (await node.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(footer.x);
      expect(box.x + box.width).toBeLessThanOrEqual(footer.x + footer.width);
      expect(box.y).toBeGreaterThanOrEqual(footer.y);
      expect(box.y + box.height).toBeLessThanOrEqual(footer.y + footer.height);
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(await node.evaluate(element => {
        const r = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
    }
    for (const [label, route] of [["needs you", "/needs-you"], ["running", "/sessions"], ["waiting", "/tasks"], ["done today", "/tasks"]]) {
      await page.getByRole("navigation", { name: "Task counts" }).getByRole("link", { name: new RegExp(label!) }).click();
      expect(await calls()).toContainEqual(["open", route]);
    }
    await page.getByRole("link", { name: /New task/ }).click();
    await page.getByRole("link", { name: /Open pacer/ }).click();
    expect(await calls()).toContainEqual(["open", "/tasks/new"]);
    expect(await calls()).toContainEqual(["open", "/"]);
    await page.getByRole("button", { name: "Pause delegation for 1 hour", exact: true }).click();
    expect(await calls()).toContainEqual(["delegation.pause", { for: "1h" }]);
    await page.getByRole("button", { name: "More", exact: true }).click();
    expect(await page.getByRole("button", { name: /Strategy/ }).evaluate(node=>node===document.activeElement)).toBe(true);
    for (const key of ["End","ArrowDown","Home","ArrowUp"]) {
      await page.keyboard.press(key);
      expect(await page.locator("#tray-menu").evaluate(node=>node.contains(document.activeElement))).toBe(true);
    }
    const popup = (await page.locator("#tray-menu").boundingBox())!;
    const minimum = await page.locator("#tray-menu").evaluate(node=>node.getBoundingClientRect().height+parseFloat(getComputedStyle(node).bottom));
    expect(popup.y).toBeGreaterThanOrEqual(0);
    expect(popup.x).toBeGreaterThanOrEqual(0);
    expect(popup.x + popup.width).toBeLessThanOrEqual(width);
    expect(popup.y + popup.height).toBeLessThan(footer.y);
    expect((await calls()).filter((call:any[])=>call[0]==="resize").at(-1)[1]).toBeGreaterThanOrEqual(Math.min(560,minimum));
    const executorBoxes = await page.locator(".tray-executor:visible").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
    expect(new Set(executorBoxes).size).toBe(1);
    for(const node of await page.locator(".tray-executor:visible").all()) expect((await node.boundingBox())!.x+(await node.boundingBox())!.width).toBeLessThanOrEqual(width);
    expect(await page.getByRole("button", { name: /Strategy/ }).textContent()).toContain("default");
    expect(await page.getByRole("link", { name: /Settings/ }).getAttribute("href")).toBe("/app/#/settings");
    expect(await page.getByRole("button", { name: /Quit pacer/ }).count()).toBe(1);
    expect(await page.getByRole("switch", { name: "Open at login" }).isChecked()).toBe(true);
    await page.getByRole("switch", { name: "Open at login" }).uncheck();
    expect(await calls()).toContainEqual(["login",false]);
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
    expect(modeBox.x + modeBox.width).toBeLessThanOrEqual(width - 14);
    expect(await page.getByRole("button", { name: "Resume delegation", exact: true }).locator("path").getAttribute("d")).toBe("M8 5l11 7-11 7z");
    await page.evaluate(() => (window as any).draw(false, false));
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.evaluate(()=>{(window as any).calls=[];});
    await page.keyboard.press("Meta+q");
    expect(await calls()).not.toContainEqual(["quit"]);
    expect(await page.getByRole("button", { name: /Quit pacer/ }).count()).toBe(0);
    expect(await page.locator(".tray-menu-divider").count()).toBe(0);
    expect(await page.getByRole("switch", { name: "Open at login" }).count()).toBe(0);
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

browserTest("a squeezed planner header keeps the name and caption while the pace text truncates", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 200 } });
    const header = (pill: string) => `<div class="tray"><main class="tray-main"><section class="tray-planner"><div class="tray-line"><strong>Codex</strong><span class="tray-planner-label">planner</span><span class="tray-grow"></span><span class="pc-pill"><span class="tray-pace-label">${pill}</span></span><span class="tray-mode">Paused</span></div></section></main></div>`;
    await page.setContent(header("Ahead"));
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    const visible = () => page.evaluate(() => {
      const slot = document.querySelector(".tray-line")!.getBoundingClientRect(), label = document.querySelector(".tray-planner-label")!.getBoundingClientRect();
      return label.top < slot.bottom && label.bottom > slot.top && label.right > slot.left && label.left < slot.right;
    });
    const nameFits = () => page.locator(".tray-line strong").evaluate(node => node.scrollWidth <= node.clientWidth);
    expect(await visible()).toBe(true);
    await page.evaluate(html => { document.body.innerHTML = html; }, header("? Usage unknown · ahead"));
    expect(await visible()).toBe(true);
    expect(await page.locator(".tray-planner-label").textContent()).toBe("planner");
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

browserTest("a medium squeeze preserves the planner name and caption before pace text", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 340, height: 200 } });
    await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
    for (const pill of ["On pace · ahead", "On pace · ah", "On pace"]) {
      await page.evaluate(pill => { document.body.innerHTML = `<div class="tray"><main class="tray-main"><section class="tray-planner"><div class="tray-line"><strong>Claude Code</strong><span class="tray-planner-label">planner</span><span class="tray-grow"></span><span class="pc-pill"><span class="tray-pace-label">${pill}</span></span><span class="tray-mode">Paused</span></div></section></main></div>`; }, pill);
      const fit = await page.evaluate(() => {
        const name = document.querySelector(".tray-line strong")!, range = document.createRange(); range.selectNodeContents(name);
        return { box: name.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
      });
      expect(fit.box).toBeGreaterThanOrEqual(fit.text - 0.01);
      expect(await page.locator(".tray-planner-label").textContent()).toBe("planner");
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
        const ipc = { desktop: true, loginItem: async enabled => { window.calls.push(["login",enabled]); return enabled ?? true; }, open: async () => {}, resize: async () => {}, hide: async () => {}, quit: async () => {} };
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
      expect(fit.name.width).toBeGreaterThan(0);
      expect(await page.locator(".tray-planner-label").evaluate(node => node.clientWidth >= node.scrollWidth)).toBe(true);
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
        expect(fit.name.width).toBeGreaterThanOrEqual(fit.textWidth - 0.05);
        expect(fit.labelClient).toBeGreaterThan(0);
      } else {
        expect(fit.name.width).toBeLessThan(fit.textWidth);
        expect(fit.labelScroll).toBeGreaterThanOrEqual(fit.labelClient);
      }
      if (process.env.PACER_TRAY_SCREENSHOTS) {
        console.log(JSON.stringify({ width, state, ...fit }));
        await page.screenshot({ path: `${process.env.PACER_TRAY_SCREENSHOTS}/header-${width}-${state}.png` });
      }
    }
  } finally { await browser.close(); }
}, 20000);


browserTest("production tray contains footer across its breakpoint and scrolls long menus in short windows", async () => {
  const files = await buildApp();
  const selected: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = files.find(file => `/app/${file.path}` === path);
    if (file) return new Response(file.text, { headers: { "content-type": file.type } });
    if (path === "/v3/hello") return Response.json({ protocol: "3.0.0", ops: [], events: ["attention"] });
    if (path === "/v3/snapshot") return Response.json({ snapshot: { ...trayBoard("paused"), strategies: Array.from({ length: 20 }, (_, i) => ({ name: `strategy-${i}`, active: i === 0 })) }, seq: 1 });
    if (path === "/v3/events") return new Response(": connected\n\n", { headers: { "content-type": "text/event-stream" } });
    if (path === "/v3/ops/strategy.use") {
      selected.push(await request.json());
      return Response.json({});
    }
    return new Response("Missing fixture route", { status: 404 });
  } });
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => { (window as any).__TAURI__ = { core: { invoke: async () => true } }; });
    await page.goto(`${server.url}app/tray.html`);
    await page.locator(".tray-mode").waitFor();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      // Sweep count-label fit and both footer breakpoints through the standard board.
      for (const width of [...Array.from({ length: 81 }, (_, i) => 260 + i), 375, 1440]) {
        await page.setViewportSize({ width, height: 560 });
        const counts = await page.locator(".tray-count").evaluateAll(nodes => nodes.map(node => {
          const cell = node.getBoundingClientRect();
          const label = node.querySelector("span")!;
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          return { left: cell.left, right: cell.right, top: cell.top, height: cell.height,
            textLeft: text.left, textRight: text.right, label: label.textContent,
            fontSize: parseFloat(getComputedStyle(label).fontSize) };
        }));
        expect(counts.map(cell => cell.label)).toEqual(["needs you", "running", "waiting", "done today"]);
        for (const [index, cell] of counts.entries()) {
          expect(cell.left).toBeGreaterThanOrEqual(1);
          expect(cell.right).toBeLessThanOrEqual(Math.min(width, 340) - 1);
          expect(cell.textLeft).toBeGreaterThanOrEqual(cell.left + 4);
          expect(cell.textRight).toBeLessThanOrEqual(cell.right - 4);
          expect(cell.fontSize).toBeGreaterThanOrEqual(12);
          expect(cell.height).toBeGreaterThanOrEqual(32);
          expect(cell.top).toBe(counts[0]!.top);
          if (index) expect(cell.textLeft - counts[index - 1]!.textRight).toBeGreaterThanOrEqual(8);
        }
        const footer = (await page.locator(".tray-footer").boundingBox())!;
        expect(footer.x + footer.width).toBeLessThanOrEqual(Math.min(width, 340));
        for (const action of await page.locator(".tray-footer .pc-btn").all()) {
          const box = (await action.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(footer.x);
          expect(box.x + box.width).toBeLessThanOrEqual(footer.x + footer.width);
          expect(box.y).toBeGreaterThanOrEqual(footer.y);
          expect(box.y + box.height).toBeLessThanOrEqual(footer.y + footer.height);
          expect(box.height).toBeGreaterThanOrEqual(32);
        }
        if (width >= 340) expect(footer.height).toBe(53);
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.keyboard.press("Escape");
        expect(await page.getByRole("button", { name: "More", exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
      }
      for (const width of [260, 339, 340]) {
        await page.setViewportSize({ width, height: 320 });
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("button", { name: /Strategy/ }).click();
        const menu = page.locator("#tray-menu");
        const box = (await menu.boundingBox())!;
        const footer = (await page.locator(".tray-footer").boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(1);
        expect(box.x).toBeGreaterThanOrEqual(1);
        expect(box.x + box.width).toBeLessThanOrEqual(width - 1);
        expect(box.y + box.height).toBeLessThan(footer.y);
        expect(await menu.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        // Both ends must be reachable; a center hit alone misses partial clipping.
        await page.getByRole("button", { name: "strategy-19", exact: true }).scrollIntoViewIfNeeded();
        await page.getByRole("button", { name: /Strategy/ }).scrollIntoViewIfNeeded();
        const heading = (await page.getByRole("button", { name: /Strategy/ }).boundingBox())!;
        expect(heading.y).toBeGreaterThanOrEqual(box.y);
        await page.getByRole("button", { name: "strategy-19", exact: true }).click();
        await page.locator("#tray-menu").waitFor({ state: "detached" });
        expect(selected.at(-1)).toEqual({ name: "strategy-19" });
      }
    }
  } finally { await browser.close(); server.stop(true); }
}, 60000);


browserTest("production tray large counts retain full accessible values without escaping their cells", async () => {
 const built=await Bun.build({entrypoints:["large-count-fixture"],target:"browser",format:"esm",tsconfig:"app/tsconfig.json",plugins:[{name:"large-counts",setup(b){
  b.onResolve({filter:/^large-count-fixture$/},()=>({path:"counts",namespace:"fixture"}));
  b.onLoad({filter:/.*/,namespace:"fixture"},()=>({loader:"tsx",resolveDir:process.cwd(),contents:`/** @jsxImportSource preact */
   import {render} from 'preact';import {Tray} from './app/src/tray/Tray';import {trayBoard} from './test/fixtures/tray-board';
   window.draw=count=>{const snapshot=trayBoard('busy');snapshot.counts.running=count;snapshot.today.done=count;
    render(<Tray snapshot={snapshot} api={{call:async()=>({})}} ipc={{desktop:false,open:async route=>window.opened=route,resize:async()=>{},hide:async()=>{}}}/>,document.getElementById('app'));};
  `}));
 }}]});
 expect(built.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {
  const page=await browser.newPage();await page.setContent('<div id="app"></div>');
  await page.addStyleTag({content:(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/tray/tray.css'].map(p=>Bun.file(p).text()))).join('\n')});
  await page.addScriptTag({type:'module',content:await built.outputs[0]!.text()});
  for(const theme of ['light','dark'])for(const width of [260,300,339,340,375])for(const count of [123456,9999,999,9,Number.MAX_SAFE_INTEGER]) {
   await page.setViewportSize({width,height:560});await page.evaluate(({theme,count})=>{document.documentElement.dataset.theme=theme;(window as any).draw(count);},{theme,count});
   const cells=page.locator('.tray-count');await cells.first().waitFor();
   const fit=await cells.evaluateAll(nodes=>nodes.map(node=>{
    const box=node.getBoundingClientRect(),digit=node.querySelector('b')!,label=node.querySelector('span')!,r=document.createRange();r.selectNodeContents(label);
    return {left:box.left,right:box.right,scroll:node.scrollWidth,client:node.clientWidth,number:digit.getBoundingClientRect().toJSON(),label:r.getBoundingClientRect().toJSON(),full:node.getAttribute('aria-label'),title:node.getAttribute('title'),text:digit.textContent,caption:label.textContent};
   }));
   for(const cell of fit){expect(cell.right).toBeLessThanOrEqual(Math.min(width,340)-1);expect(cell.scroll).toBeLessThanOrEqual(cell.client);expect(cell.number.left).toBeGreaterThanOrEqual(cell.left);expect(cell.number.right).toBeLessThanOrEqual(cell.right);expect(cell.label.right).toBeLessThanOrEqual(cell.right);}
   for(const cell of fit){expect(cell.full).toBe(`${cell.text} ${cell.caption}`);expect(cell.title).toBe(cell.full);}
   expect(await page.getByRole('link',{name:`${count} running`,exact:true}).textContent()).toContain(String(count));
  }
  // The real browser tray has a short menu, without native-only controls.
  for(const theme of ['light','dark'])for(const width of [260,339,340,375])for(const height of [320,560]) {
   await page.setViewportSize({width,height});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.getByRole('button',{name:'More',exact:true}).click();
   const menu=page.locator('#tray-menu'),box=(await menu.boundingBox())!;
   expect(box.y).toBeGreaterThanOrEqual(1);expect(box.x).toBeGreaterThanOrEqual(1);
   expect(box.y+box.height).toBeLessThanOrEqual(height-1);
   expect(box.x+box.width).toBeLessThanOrEqual(Math.min(width,340)-1);
   await page.keyboard.press('End');
   expect(await page.getByRole('link',{name:/Settings/}).evaluate(n=>n===document.activeElement)).toBe(true);
   await page.keyboard.press('Escape');
   expect(await page.getByRole('button',{name:'More',exact:true}).evaluate(n=>n===document.activeElement)).toBe(true);
  }
  await page.getByRole('link',{name:`${Number.MAX_SAFE_INTEGER} running`,exact:true}).focus();await page.keyboard.press('Enter');
  expect(await page.evaluate(()=>(window as any).opened)).toContain('/sessions');
 }finally{await browser.close();}
},30000);

// PR #494 live run: the policy row sat outside the padded planner block and started at x≈0 (UI-16).
browserTest("tray policy caption shares the planner inset in light and dark themes", async () => {
  const build = await Bun.build({ entrypoints: ["tray-policy-fixture"], target: "browser", plugins: [{
    name: "tray-policy-fixture", setup(builder) {
      builder.onResolve({ filter: /^tray-policy-fixture$/ }, () => ({ path: "tray-policy-fixture", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "tsx", resolveDir: process.cwd(), contents: `/** @jsxImportSource preact */
        import { render } from "preact";
        import { Tray } from "./app/src/tray/Tray";
        import fixture from "./test/fixtures/ui/snapshot.json";
        const api = { call: async () => ({}) };
        const ipc = { desktop: true, loginItem: async () => true, open: async () => {}, resize: async () => {}, hide: async () => {}, quit: async () => {} };
        render(<Tray snapshot={{...fixture, policy:{mode:"closed",plugins:123456}}} api={api} ipc={ipc} />, document.getElementById("app"));
      ` }));
    }
  }] });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width: 340, height: 560 }, colorScheme: scheme });
      await page.setContent('<div id="app"></div>');
      await page.addStyleTag({ content: (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/tray/tray.css"].map(path => Bun.file(path).text()))).join("\n") });
      await page.evaluate(async source => { await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" }))); }, await build.outputs[0]!.text());
      const policy = page.locator(".tray-policy");
      expect(await policy.textContent()).toBe("policy: closed (123456 plugins) · a failing plugin blocks the action");
      expect(await policy.evaluate(node => node.closest(".tray-planner") !== null)).toBe(true);
      const box = (await policy.boundingBox())!, caption = (await page.locator(".tray-caption").boundingBox())!, name = (await page.locator(".tray-planner .tray-line").boundingBox())!;
      // Same left inset as the planner rows above it, and contained within the 340px popover.
      expect(box.x).toBe(caption.x);
      expect(box.x).toBe(name.x);
      expect(box.x).toBeGreaterThanOrEqual(12);
      expect(box.x + box.width).toBeLessThanOrEqual(caption.x + caption.width + 0.5);
      expect(await policy.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      // Below the usage caption, inside the section's bottom border.
      expect(box.y).toBeGreaterThan(caption.y + caption.height - 0.5);
      const section = (await page.locator(".tray-planner").boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(section.y + section.height);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20000);
