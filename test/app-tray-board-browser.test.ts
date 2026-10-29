import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildApp } from "../app/build";
import { trayBoard } from "./fixtures/tray-board";

const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
browserTest("built tray.html matches board geometry and styles at 340px in all four states", async () => {
  const files = await buildApp();
  let snapshot = trayBoard("busy");
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    const file = files.find(file => `/app/${file.path}` === path);
    if (file) return new Response(file.text, { headers: { "content-type": file.type } });
    if (path === "/v3/hello") return Response.json({ protocol: "3.0.0", ops: [], events: ["attention"] });
    if (path === "/v3/snapshot") return Response.json({ snapshot, seq: 1 });
    if (path === "/v3/events") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    return new Response("Not found", { status: 404 });
  } });
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  const evidence = process.env.PACER_TRAY_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const measurements: unknown[] = [];
  try {
    for (const theme of ["light", "dark"] as const) for (const state of ["busy", "clear", "paused", "dark"] as const) {
      snapshot = trayBoard(state);
      const page = await browser.newPage({ viewport: { width: 340, height: 560 }, colorScheme: theme, timezoneId: "Asia/Ho_Chi_Minh", reducedMotion: "reduce" });
      await page.addInitScript(() => {
        (window as any).login = true;
        (window as any).calls = [];
        (window as any).__TAURI__ = { core: { invoke: async (command: string, args?: any) => {
          (window as any).calls.push([command, args]);
          if (command === "tray_login_item") { if ((window as any).failLogin) throw Error("Login item refused"); if (args?.enabled !== undefined) (window as any).login = args.enabled; return (window as any).login; }
        } } };
      });
      await page.goto(`${server.url}app/tray.html`);
      await page.getByText("executors", { exact: true }).waitFor();
      if (state === "paused") await page.getByRole("button", { name: "More", exact: true }).click();
      const actual = await page.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const strip = document.querySelector(".tray-executors")!, rect = strip.getBoundingClientRect();
        const items = [...strip.querySelectorAll<HTMLElement>("a:not([hidden])")].map(node => ({ text: node.textContent, x: node.getBoundingClientRect().x, right: node.getBoundingClientRect().right, y: node.getBoundingClientRect().y }));
        const kbd = style(".pc-kbd"), caption = document.querySelector(".tray-planner-label")!;
        const glyph = document.querySelector(".tray-attention-glyph");
        return { items, strip: { width: rect.width, height: rect.height, wrap: style(".tray-executors").flexWrap, gap: style(".tray-executors").gap },
          caption: { text: caption.textContent, width: caption.clientWidth, scroll: caption.scrollWidth, right: caption.getBoundingClientRect().right },
          kbd: { font: kbd.fontFamily, mono: style(":root").getPropertyValue("--font-mono").trim(), size: kbd.fontSize, line: kbd.lineHeight, padding: kbd.padding, radius: kbd.borderRadius, opacity: kbd.opacity, border: kbd.borderTopWidth, color: kbd.color, borderColor: kbd.borderTopColor },
          glyphs: [...document.querySelectorAll(".tray-attention-glyph")].map(node => ({ text: node.textContent, width: getComputedStyle(node).width, weight: getComputedStyle(node).fontWeight, color: getComputedStyle(node).color, expectedColor: (() => { const probe = document.createElement("span"); probe.style.color = node.textContent === "✕" ? "var(--bad-fg)" : node.textContent === "●" ? "var(--info-fg)" : "var(--warn-fg)"; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })() })),
          warn: glyph ? style(":root").getPropertyValue("--warn-fg").trim() : null,
          reset: document.querySelector(".tray-caption")!.lastElementChild!.textContent,
          count: { size: style(".tray-count b").fontSize, line: style(".tray-count b").lineHeight, weight: style(".tray-count b").fontWeight },
          name: (() => { const node = document.querySelector<HTMLElement>(".tray-line strong")!; const range = document.createRange(); range.selectNodeContents(node); return { width: node.getBoundingClientRect().width, textWidth: range.getBoundingClientRect().width }; })(),
          buttons: [...document.querySelectorAll(".tray-footer .pc-btn--sm,.tray-attention .pc-btn")].map(node => getComputedStyle(node).minHeight),
          offMark: document.querySelector(".tray-executor--off .pc-agent-mark")?.getBoundingClientRect().width,
          offTooltip: document.querySelector(".tray-executor--off")?.getAttribute("title"),
          unmeteredColor: style(".tray-executor-value--muted").color,
          mutedColor: style(".tray-executors .tray-reason").color,
          menuRadius: document.querySelector(".tray-menu") ? style(".tray-menu").borderRadius : null,
          menu: [...document.querySelectorAll(".tray-menu-item")].map(node => node.textContent?.trim()),
        };
      });
      expect(actual.count).toEqual({ size: "22px", line: "26px", weight: "650" });
      expect(actual.name.width).toBeGreaterThanOrEqual(actual.name.textWidth);
      expect(actual.buttons.every(height => height === "32px")).toBe(true);
      expect(actual.offMark).toBe(16);
      expect(actual.offTooltip).toContain("Cursor: turned off");
      expect(actual.offTooltip).toContain("BytePlus: no active subscription");
      expect(actual.unmeteredColor).toBe(actual.mutedColor);
      expect(actual.offTooltip).not.toContain("Eligible");
      expect(actual.strip.wrap).toBe("nowrap"); expect(actual.strip.gap).toBe("12px");
      expect(new Set(actual.items.map(item => item.y)).size).toBe(1);
      expect(actual.items.map(item => item.text)).toEqual(["81%", "22%", "—", "2 off"]);
      for (const item of actual.items) expect(item.right).toBeLessThanOrEqual(325);
      expect(actual.caption.width).toBeGreaterThanOrEqual(actual.caption.scroll);
      expect(actual.caption.text).toBe("planner");
      expect(actual.reset).toBe("resets Fri 12:00");
      expect(actual.kbd).toMatchObject({ size: "11px", line: "14px", padding: "0px 5px", radius: "4px", opacity: "0.7", border: "1px" });
      expect(actual.kbd.color).toBe(actual.kbd.borderColor);
      expect(actual.kbd.font.replace(/["']/g, "")).toBe(actual.kbd.mono.replace(/["']/g, ""));
      if (state !== "clear") {
        expect(actual.glyphs.map(glyph => glyph.text)).toEqual(state === "paused" ? ["◐"] : ["◐", "✕", "●"]);
        for (const glyph of actual.glyphs) { expect(glyph).toMatchObject({ width: "14px", weight: "700" }); expect(glyph.color).toBe(glyph.expectedColor); }
      }
      if (state === "clear") expect(await page.getByText("Last review cleared 11:42").count()).toBe(1);
      if (state === "paused") {
        expect(actual.menuRadius).toBe("12px");
        expect(actual.menu).toEqual(["Strategyno-agy", "Open at login", "Settings⌘,", "Quit pacer⌘Q"]);
        expect(await page.getByRole("switch").isChecked()).toBe(true);
        await page.locator("label.tray-menu-item .tray-grow").click();
        await page.waitForFunction(() => !(document.querySelector('[role="switch"]') as HTMLInputElement).checked);
        expect(await page.evaluate(() => (window as any).login)).toBe(false);
        await page.getByRole("switch").check();

        expect(await page.locator(".tray-menu .pc-kbd").first().evaluate(node => getComputedStyle(node).opacity)).toBe("0.7");
      }
      if (state === "busy") {
        // Unrelated menu renders must not rewrite the executor strip.
        await page.evaluate(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          (window as any).stripMutations = 0;
          new MutationObserver(records => { (window as any).stripMutations += records.length; }).observe(document.querySelector(".tray-executors")!, { attributes: true, childList: true, subtree: true });
        });
        await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("switch").isEnabled();
        await page.keyboard.press("Escape");
        expect(await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return (window as any).stripMutations; })).toBe(0);
      }
      if (evidence) {
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.screenshot({ path: join(evidence, `${state}-${theme}-340.png`) });
        if (state === "busy" || state === "dark") {
          await page.locator(".tray-main").evaluate(node => { node.scrollTop = node.scrollHeight; });
          await page.screenshot({ path: join(evidence, `${state}-${theme}-strip-340.png`) });
        }
      }
      if (state === "paused") {
        await page.evaluate(() => { (window as any).failLogin = true; });
        await page.getByRole("switch").click();
        await page.getByRole("alert").filter({ hasText: "Login item refused" }).waitFor();
        expect(await page.getByRole("switch").isChecked()).toBe(true);
      }
      measurements.push({ state, theme, ...actual });
      await page.close();
    }
    // Overflow preserves the first enabled rows and links the remainder.
    snapshot = trayBoard("busy");
    snapshot.executors = [...snapshot.executors!, ...Array.from({ length: 10 }, (_, i) => ({ ...snapshot.executors![1]!, id: `extra-${i}`, rank: i + 5 }))];
    const page = await browser.newPage({ viewport: { width: 340, height: 560 } });
    await page.goto(`${server.url}app/tray.html`);
    const overflow = page.locator("[data-overflow]");
    await overflow.waitFor({ state: "visible" });
    expect(await overflow.textContent()).toMatch(/^\+\d+$/);
    expect(await overflow.getAttribute("href")).toBe("/app/#/settings/executors");
    expect(await overflow.getAttribute("title")).toContain("parallel tasks");
    const strip = page.locator(".tray-executors");
    expect(await strip.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.locator("[data-executor]:visible").count()).toBeGreaterThan(0);
    // The next enabled row cannot fit even when the +N count shrinks a digit.
    expect(await strip.evaluate(node => {
      const hidden = [...node.querySelectorAll<HTMLElement>("[data-executor][hidden]")];
      const next = hidden[0]!;
      next.hidden = false;
      const more = node.querySelector<HTMLElement>("[data-overflow]")!;
      more.textContent = `+${hidden.length - 1}`;
      more.hidden = hidden.length === 1;
      return node.scrollWidth > node.clientWidth;
    })).toBe(true);
    await page.close();
    if (evidence) await Bun.write(join(evidence, "computed-styles.json"), JSON.stringify(measurements, null, 2));
  } finally { await browser.close(); server.stop(true); }
}, 30000);
