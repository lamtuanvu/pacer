import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { buildApp } from "../app/build";

const login = process.env.PACER_DISPATCH_TEST_URL;
test.skipIf(!login || !process.env.PACER_TEST_BROWSER)("live Dispatch starts closed, remembers window choices and never queries an unselected task", async () => {
  const files = new Map((await buildApp()).map(file => [file.path, file]));
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  const output = process.env.PACER_DISPATCH_EVIDENCE;
  if (output) mkdirSync(output, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/app/**", route => {
      const file = files.get(new URL(route.request().url()).pathname.slice(5));
      return file && file.path !== "index.html" ? route.fulfill({ contentType: file.type, body: file.text }) : route.continue();
    });
    const page = await context.newPage();
    const taskReads: string[] = [];
    page.on("request", request => { if (request.url().includes("/ops/task.get")) taskReads.push(request.postData() ?? ""); });
    await page.goto(login!);
    const ready = () => page.locator(".pc-dispatch-decision").first().waitFor();
    await ready();
    const scope = page.getByRole("complementary", { name: "Scope", exact: true });
    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    expect(await scope.count()).toBe(0);
    expect(await inspector.count()).toBe(0);
    const measurements = [];
    for (const density of ["normal", "compact"]) {
      await page.evaluate(density => document.documentElement.dataset.density = density, density);
      const geometry = await page.locator(".pc-dispatch-decision").first().evaluate(node => {
        const style = getComputedStyle(node);
        return { padding: style.padding, gap: style.gap, columns: style.gridTemplateColumns, width: node.getBoundingClientRect().width };
      });
      expect(geometry.padding).toBe("9px 20px");
      expect(geometry.gap).toBe("12px");
      const columns = geometry.columns.split(" ").map(parseFloat);
      expect(columns.filter((_, i) => i !== 1)).toEqual([44, 76, 150, 220, 64, 112]);
      measurements.push({ density, ...geometry });
    }
    if (output) await Bun.write(`${output}/computed-style.json`, JSON.stringify(measurements, null, 2));
    const capture = async (name: string) => {
      if (!output) return;
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({ path: `${output}/${name}-${colorScheme}.png` });
      }
    };
    await capture("closed-1440");
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    await inspector.getByText("Select a task to see its details.").waitFor();
    expect(await inspector.getByText("Loading task…").count()).toBe(0);
    const recent = inspector.getByRole("link").filter({ hasText: /.+/ }).first();
    expect(await recent.getAttribute("href")).toMatch(/^#\/tasks\//);
    await recent.focus();
    expect(await recent.evaluate(node => node === document.activeElement)).toBe(true);
    await capture("empty-inspector-1440");
    await page.getByRole("button", { name: "Toggle left panel", exact: true }).click();
    await scope.waitFor();
    await page.reload();
    await inspector.getByText("Select a task to see its details.").waitFor();
    await scope.waitFor();
    expect(taskReads).toEqual([]);
    const otherWindow = await context.newPage();
    await otherWindow.goto(new URL("/app/#/", page.url()).href);
    await otherWindow.locator(".pc-dispatch-decision").first().waitFor();
    expect(await otherWindow.getByRole("complementary", { name: "Scope", exact: true }).count()).toBe(0);
    expect(await otherWindow.getByRole("complementary", { name: "Inspector", exact: true }).count()).toBe(0);
    await otherWindow.close();
    await page.getByRole("button", { name: "Toggle left panel", exact: true }).click();
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    await page.setViewportSize({ width: 375, height: 900 });
    await capture("closed-375");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await browser.close(); }
}, 30000);
