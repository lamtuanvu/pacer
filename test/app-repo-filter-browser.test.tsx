import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ["test/fixtures/repo-filter-browser.tsx"], target: "browser" });
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  const styles = (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/styles.css"].map(path => Bun.file(path).text()))).join("\n");
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(
    `<div id="root"></div><style>${styles}</style><script type="module">${script}</script>`,
    { headers: { "Content-Type": "text/html" } },
  ) });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 15000);

browserTest("repository finder searches all repos, selects an idle repo and preserves route scope", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto(`${server.url}#/needs-you?scope=all`);
    const trigger = page.getByRole("button", { name: "Find repo" });
    await trigger.click();
    const search = page.getByRole("searchbox", { name: "Search repositories" });
    expect(await search.evaluate(node => node === document.activeElement)).toBe(true);
    await search.fill("  EMPTY-REPO  ");
    const row = page.getByRole("button", { name: /empty-repo/ });
    expect(await row.count()).toBe(1);
    expect(await row.getByLabel("0 work items").textContent()).toBe("0");
    await row.click();
    await page.waitForFunction(() => location.hash.includes("repo=github.com%2Fecon-v1%2Fempty-repo"));
    await page.waitForFunction(() => document.querySelector('.pc-chip[aria-pressed="true"]')?.textContent?.includes("empty-repo"));
    expect(page.url()).toContain("scope=all");
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true);
    expect(await page.getByRole("button", { name: /econ-v1\/empty-repo/ }).getAttribute("aria-pressed")).toBe("true");
    await trigger.click();
    expect(await search.inputValue()).toBe("");
    await search.fill("not-a-repo");
    expect(await page.getByRole("status").textContent()).toContain("No matching repositories");
  } finally { await page.close(); }
});

browserTest("repository finder supports arrow keys, Escape, outside click and Tab dismissal", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto(`${server.url}#/needs-you`);
    const trigger = page.getByRole("button", { name: "Find repo" });
    await trigger.click();
    const search = page.getByRole("searchbox");
    await search.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-pressed"))).toBe("true");
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("empty-repo");
    await page.keyboard.press("Home");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("All repos");
    await page.keyboard.press("Escape");
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true);
    await trigger.click();
    await search.press("ArrowUp");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("empty-repo");
    await page.keyboard.press("Tab");
    expect(await page.getByRole("link", { name: "Next section" }).evaluate(node => node === document.activeElement)).toBe(true);
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
    await trigger.click();
    await page.getByRole("heading", { name: "Repository filter" }).click();
    expect(await trigger.getAttribute("aria-expanded")).toBe("false");
  } finally { await page.close(); }
});

browserTest("repository badges and anchored menu fit desktop and narrow layouts in both themes", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  try {
    for (const width of [1440, 375]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${server.url}#/needs-you`);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const trigger = page.getByRole("button", { name: "Find repo" });
      await trigger.click();
      const menu = page.locator(".pc-search-picker__popover");
      const bounds = await menu.boundingBox();
      const anchor = await trigger.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(Math.abs(bounds!.y - (anchor!.y + anchor!.height) - 8)).toBeLessThan(1);
      if (width > 560) expect(Math.abs(bounds!.x + bounds!.width - anchor!.x - anchor!.width)).toBeLessThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const badge = page.locator(".pc-chip").getByLabel("32 work items");
      expect(await badge.getAttribute("aria-label")).toBe("32 work items");
      expect(await badge.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await page.keyboard.press("Escape");
    }
  } finally { await page.close(); }
});

browserTest("unbroken repository names retain their full identity without overflowing narrow controls", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  page.setDefaultTimeout(10000);
  const name = "a".repeat(100);
  try {
    await page.goto(`${server.url}#/needs-you`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const chip = page.getByRole("button", { name: `econ-v1/${name} 40 work items`, exact: true });
    expect(await chip.getAttribute("title")).toBe(`econ-v1/${name}`);
    expect(await chip.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.getByRole("button", { name: "Find repo" }).click();
    const row = page.locator(".pc-search-picker__option").filter({ hasText: name });
    expect(await row.getAttribute("title")).toBe(`econ-v1/${name}`);
    expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await row.click();
    await page.waitForFunction(name => document.querySelector('.pc-chip[aria-pressed="true"]')?.textContent?.includes(name), name);
    expect(await chip.getAttribute("aria-pressed")).toBe("true");
  } finally { await page.close(); }
});
