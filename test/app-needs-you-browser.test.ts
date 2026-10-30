import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
const browserPath = process.env.PACER_TEST_BROWSER;

test.skipIf(!browserPath)("Needs you filters, opens a trapped Answer panel and sends a revision-checked answer", async () => {
  const build = await Bun.build({ entrypoints: ["test/fixtures/ui/needs-you.tsx"], target: "browser" });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const server = Bun.serve({ port: 0, fetch: () => new Response('<div id="fixture"></div>', { headers: { "content-type": "text/html" } }) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(server.url.toString());
    await page.addStyleTag({ content: await Bun.file("app/src/ds/tokens.css").text() + await Bun.file("app/src/ds/components.css").text() + await Bun.file("app/src/styles.css").text() });
    await page.addScriptTag({ content: await build.outputs[0]!.text(), type: "module" });
    await page.getByRole("tab", { name: /Questions/ }).click();
    expect(await page.locator(".ny-item").count()).toBe(1);
    expect(await page.locator(".ny-content").getAttribute("href")).toBe("#/tasks/question");
    const answerLink = page.getByRole("link", { name: "Answer", exact: true });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await answerLink.hover();
      expect(await answerLink.evaluate(element => getComputedStyle(element).color)).not.toBe(await answerLink.evaluate(element => getComputedStyle(element).backgroundColor));
    }
    await answerLink.click();
    const dialog = page.getByRole("dialog", { name: "Codex asks" });
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector(".ny-output pre")?.textContent?.includes("Waiting for your answer"));
    expect(await dialog.evaluate(element => element.getBoundingClientRect().width)).toBe(480);
    expect(await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return [rect.right, rect.top, innerHeight - rect.bottom]; })).toEqual([1440, 36, 28]);
    await dialog.getByRole("button", { name: "Hide it", exact: true }).click();
    expect(await dialog.locator("textarea").inputValue()).toBe("Hide it");
    for (let n = 0; n < 12; n++) { await page.keyboard.press("Tab"); expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true); }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await page.getByRole("link", { name: "Answer", exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
    await page.getByRole("link", { name: "Answer", exact: true }).click();
    await dialog.locator("textarea").fill("Keep the expiry date visible");
    await page.keyboard.press("Meta+Enter");
    await dialog.waitFor({ state: "detached" });
    expect(await page.evaluate(() => (window as unknown as { answer: unknown }).answer)).toEqual({ id: "question", text: "Keep the expiry date visible", expect_rev: 7 });
    await page.getByRole("tab", { name: /Failed/ }).click();
    for (const link of await page.getByRole("link", { name: "Inspect failures", exact: true }).all()) expect(await link.getAttribute("href")).toMatch(/\/failure$/);
    await page.getByRole("tab", { name: /To review/ }).click();
    for (const link of await page.getByRole("link", { name: "Review", exact: true }).all()) expect(await link.getAttribute("href")).toMatch(/\/review$/);
  } finally { await browser.close(); await server.stop(); }
}, 30000);
