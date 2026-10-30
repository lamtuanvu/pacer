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
    const footnote = page.locator(".ny-footnote");
    expect(await footnote.textContent()).toBe("Answering, retrying or accepting here resumes the task where it stopped. Everything you do is recorded in the task's dispatch trace.");
    expect(await footnote.evaluate(el => { const s = getComputedStyle(el); return [s.fontSize, s.lineHeight, s.color]; })).toEqual(["12px", "16px", await page.locator(".ny-header .ny-cap").evaluate(el => getComputedStyle(el).color)]);
    const warning = page.getByRole("region", { name: "Agents needing attention" });
    expect(await warning.locator("b").textContent()).toBe("3 agents can't take work");
    expect(await warning.evaluate(el => { const s = getComputedStyle(el); return [s.padding, s.borderRadius, s.borderWidth]; })).toEqual(["12px", "12px", "1px"]);
    expect(await warning.locator(".ny-warning").evaluate(el => getComputedStyle(el).gap)).toBe("10px");
    expect(await warning.evaluate(el => el.getBoundingClientRect().top - document.querySelector(".ny-list")!.getBoundingClientRect().bottom)).toBe(16);
    expect(await footnote.evaluate(el => el.getBoundingClientRect().top - document.querySelector(".pc-card--warn")!.getBoundingClientRect().bottom)).toBe(16);
    expect(await warning.locator(".ny-glyph").evaluate(el => getComputedStyle(el).lineHeight)).toBe("19px");
    const fix = warning.getByRole("link", { name: "Fix in Agents" });
    expect(await fix.getAttribute("href")).toBe("#/settings/executors");
    expect(await fix.getAttribute("class")).toContain("pc-btn--secondary pc-btn--sm");
    expect(await warning.locator(".ny-cap").evaluate(el => el.getBoundingClientRect().height)).toBe(16);
    await page.getByRole("tab", { name: /Questions/ }).click();
    expect(await page.getByRole("link", { name: "Open in workspace", exact: true }).getAttribute("href")).toBe("#/tasks/question");
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
    for (const link of await page.getByRole("link", { name: "Open workspace", exact: true }).all()) expect(await link.getAttribute("href")).toMatch(/^#\/tasks\/[^/]+$/);
    for (const link of await page.getByRole("link", { name: "Review", exact: true }).all()) expect(await link.getAttribute("href")).toMatch(/\/review$/);
  } finally { await browser.close(); await server.stop(); }
}, 30000);
