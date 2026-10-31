import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { buildApp } from "../app/build";
import { mkdirSync, writeFileSync } from "node:fs";

// Use only a fresh login from live up --seed ui. The service remains behind D8.
const login = process.env.PACER_FIDELITY_TEST_URL;
test.skipIf(!login || !process.env.PACER_TEST_BROWSER)("seeded Tasks and New task preserve board geometry and accessible colors", async () => {
  const files = new Map((await buildApp()).map(file => [file.path, file]));
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  const evidence = process.env.PACER_FIDELITY_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const results: unknown[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/app/**", route => {
      const file = files.get(new URL(route.request().url()).pathname.slice(5));
      return file && file.path !== "index.html" ? route.fulfill({ contentType: file.type, body: file.text }) : route.continue();
    });
    const page = await context.newPage();
    await page.goto(login!);
    for (const theme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const width of [1440, 768, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await page.evaluate(() => { location.hash = "#/tasks"; });
        await page.waitForFunction(() => document.querySelector(".pc-tasks-page__caption")?.textContent?.includes("2 subtasks"));
        if (width !== 375) await page.locator(".pc-task-aside__activity").first().waitFor();
        const observed = await page.evaluate(() => {
          const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const title = rect(".pc-task-card__title"), icon = rect(".pc-search-input svg"), input = rect(".pc-search-input input");
          return { titleWidth: title.width, searchGap: input.left - icon.right, overflow: document.documentElement.scrollWidth > innerWidth, scope: !!document.querySelector('[aria-label="Scope"]'), inspector: !!document.querySelector('[aria-label="Inspector"]'), animations: [...document.querySelectorAll(".pc-status-dot__dot--live")].map(el => getComputedStyle(el).animationName) };
        });
        expect(observed.titleWidth).toBeGreaterThan(100);
        expect(observed.searchGap).toBe(8);
        expect(observed.overflow).toBe(false);
        expect(observed.scope).toBe(false);
        expect(observed.inspector).toBe(false);
        expect(observed.animations.every(name => name === "none")).toBe(true);
        await page.getByRole("searchbox", { name: "Search tasks" }).focus();
        expect(await page.locator(".pc-search-input").evaluate(el => getComputedStyle(el).outlineStyle)).toBe("solid");
        results.push({ theme, width, route: "tasks", ...observed });
        if (evidence) await page.screenshot({ path: `${evidence}/tasks-${width}-${theme}.png` });
        await page.evaluate(() => { location.hash = "#/tasks/new"; });
        if (width === 375) {
          await page.locator(".pc-new-task-sheet").waitFor();
          expect(await page.getByText("Each row opens its own sheet with the same choices as the desktop form.").count()).toBe(0);
        } else {
          const branch = page.locator(".pc-new-task__pick .pc-choice-picker__branch");
          await branch.waitFor();
          expect(await branch.textContent()).not.toBe("");
          const picker = page.locator(".pc-new-task__pick .pc-choice-picker__trigger");
          expect(await picker.locator("svg").count()).toBe(1);
          expect(await picker.evaluate(el => getComputedStyle(el).gap)).toBe("10px");
        }
        const contrast = await page.evaluate(() => {
          const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const luminance = (c: number[]) => c.map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
          return [...document.querySelectorAll(".pc-new-task__pick strong,.pc-choice-picker__branch,.pc-new-task__more summary,.pc-request-box__hint,.pc-new-task-sheet .pc-caption")].filter(el => el.getBoundingClientRect().width > 0).map(el => {
            let parent: Element | null = el, background = "";
            while (parent) { const color = getComputedStyle(parent).backgroundColor; if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") { background = color; break; } parent = parent.parentElement; }
            const probe = document.createElement("span"); probe.style.background = "var(--surface-page)"; document.body.append(probe);
            background ||= getComputedStyle(probe).backgroundColor; probe.remove();
            const foreground = getComputedStyle(el).color, a = luminance(rgb(foreground)), b = luminance(rgb(background));
            return { text: el.textContent, foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
          });
        });
        expect(contrast.length).toBeGreaterThan(0);
        for (const item of contrast) expect(item.ratio).toBeGreaterThanOrEqual(4.5);
        results.push({ theme, width, route: "new-task", contrast });
        if (evidence) await page.screenshot({ path: `${evidence}/new-task-${width}-${theme}.png` });
      }
    }
  } finally {
    if (evidence) writeFileSync(`${evidence}/checks.json`, JSON.stringify(results, null, 2));
    await browser.close();
  }
}, 60_000);
