import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";

const browserPath = process.env.PACER_TEST_BROWSER;
let browser: Browser, server: ReturnType<typeof Bun.serve>, needsScript: string, trayScript: string;
beforeAll(async () => {
  if (!browserPath) return;
  const needs = await Bun.build({ entrypoints: ["test/fixtures/ui/needs-you.tsx"], target: "browser" });
  const tray = await Bun.build({ entrypoints: ["test/fixtures/ui/managed-tray.tsx"], target: "browser" });
  expect(needs.success).toBe(true); expect(tray.success).toBe(true);
  needsScript = await needs.outputs[0]!.text(); trayScript = await tray.outputs[0]!.text();
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<div id="fixture"></div>', { headers: { "content-type": "text/html" } }) });
});
afterAll(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

type Surface = "answer" | "retry" | "tray";
async function setup(surface: Surface, mode: string) {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(`${server.url}?managed${surface === "retry" ? "&failed" : ""}`);
  await page.evaluate(mode => { (window as any).actionMode = mode; }, mode);
  await page.addScriptTag({ content: surface === "tray" ? trayScript : needsScript, type: "module" });
  if (surface === "answer") {
    await page.getByRole("tab", { name: /Questions/ }).click();
    await page.getByRole("link", { name: "Answer", exact: true }).click();
    await page.getByRole("dialog").locator("textarea").fill("Keep this draft");
  }
  if (surface === "retry") {
    await page.locator(".ny-item").filter({ hasText: "Managed failed work" }).getByRole("link", { name: "Inspect failures" }).click();
    await page.getByRole("radio", { name: /^Retry task/ }).click();
  }
  return page;
}
const calls = (page: Page) => page.evaluate(() => (window as any).actionCalls);
const expectedCall = (surface: Surface) => surface === "answer"
  ? { op: "dispatch.answer", params: { id: "question", text: "Keep this draft", expect_rev: 7, requestId: "question.7.answer" } }
  : surface === "retry"
    ? { op: "dispatch.retry", params: { id: "managed-failed", expect_rev: 7, requestId: "managed-failed.7.retry", feedback: "" } }
    : { op: "dispatch.retry", params: { id: "managed", expect_rev: 7, requestId: "managed.7.retry" } };
const actionButton = (page: Page, surface: Surface) => page.getByRole("button", { name: surface === "answer" ? "Send answer" : surface === "retry" ? "Retry task" : "Retry", exact: true });

for (const surface of ["answer", "retry", "tray"] as const) {
  for (const mode of ["conflict", "error"] as const) {
    test.skipIf(!browserPath)(`${surface}: managed ${mode} is visible and preserves usable state`, async () => {
      const page = await setup(surface, mode);
      try {
        const button = actionButton(page, surface); await button.click();
        const message = surface === "tray"
          ? mode === "conflict" ? "Revision changed. Try again, or open pacer to finish there." : "Service temporarily unavailable. Try again, or open pacer to finish there."
          : mode === "conflict" ? "Already handled elsewhere" : "Service temporarily unavailable";
        await page.getByText(message, { exact: true }).waitFor();
        expect(await button.isEnabled()).toBe(true);
        expect(await calls(page)).toEqual([expectedCall(surface)]);
        if (surface === "answer") {
          expect(await page.getByRole("dialog").locator("textarea").inputValue()).toBe("Keep this draft");
          expect(await page.getByRole("dialog").isVisible()).toBe(true);
        } else if (surface === "tray") {
          expect(await page.getByRole("alert").innerText()).toContain(message);
          expect(await page.getByText("Managed retry").count()).toBeGreaterThan(0);
        } else expect(page.url()).toContain("/tasks/managed-failed/failure");
      } finally { await page.close(); }
    }, 30000);
  }
  test.skipIf(!browserPath)(`${surface}: rapid double activation makes one managed request`, async () => {
    const page = await setup(surface, "hold");
    try {
      const button = actionButton(page, surface);
      await button.focus();
      await button.evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
      await page.waitForFunction(() => ((window as any).actionCalls as unknown[]).length >= 1);
      expect(await calls(page)).toEqual([expectedCall(surface)]);
      await page.waitForFunction(() => typeof (window as any).releaseAction === "function");
      if (surface === "tray") {
        const working = page.getByRole("button", { name: "Working…" });
        expect(await working.getAttribute("aria-disabled")).toBe("true");
        expect(await working.isVisible()).toBe(true);
        expect(await page.locator('.sr-only[role="status"][aria-live="polite"]').innerText()).toBe("Working…");
      } else if (surface === "answer") {
        const sending = page.getByRole("button", { name: "Sending…" });
        expect(await sending.getAttribute("aria-disabled")).toBe("true");
        expect(await sending.isVisible()).toBe(true);
        expect(await sending.evaluate(e => e === document.activeElement)).toBe(true);
        expect(await page.locator('.sr-only[role="status"][aria-live="polite"]').innerText()).toBe("Sending…");
      } else expect(await button.isDisabled()).toBe(true);
      await page.evaluate(() => (window as any).releaseAction());
      if (surface === "answer") await page.getByRole("dialog").waitFor({ state: "detached" });
      else if (surface === "retry") await page.waitForURL(/workspace/);
      else await page.getByRole("button", { name: "Retry", exact: true }).waitFor({ state: "visible" });
      expect(await calls(page)).toEqual([expectedCall(surface)]);
      if (surface === "tray") expect(await page.locator('.sr-only[role="status"][aria-live="polite"]').innerText()).toBe("");
      if (surface === "answer") expect(await page.locator('.sr-only[role="status"][aria-live="polite"]').count()).toBe(0);
      if (surface === "tray") expect(await page.getByText("Managed retry").count()).toBeGreaterThan(0);
    } finally { await page.close(); }
  }, 30000);
}

for (const surface of ["answer", "retry", "tray"] as const) {
  test.skipIf(!browserPath)(`${surface}: a failed request can be retried successfully`, async () => {
    const page = await setup(surface, "error");
    try {
      await actionButton(page, surface).click();
      await page.getByText(/Service temporarily unavailable/).first().waitFor();
      await page.evaluate(() => { (window as any).actionMode = "success"; });
      await actionButton(page, surface).click();
      if (surface === "answer") await page.getByRole("dialog").waitFor({ state: "detached" });
      else if (surface === "retry") await page.waitForURL(/workspace/);
      else await page.getByRole("alert").waitFor({ state: "detached" });
      expect(await calls(page)).toEqual([expectedCall(surface), expectedCall(surface)]);
    } finally { await page.close(); }
  }, 30000);
  test.skipIf(!browserPath)(`${surface}: refresh after conflict uses the new revision`, async () => {
    const page = await setup(surface, "conflict");
    try {
      await actionButton(page, surface).click();
      await page.getByText(surface === "tray" ? /Revision changed/ : /Already handled elsewhere/).first().waitFor();
      await page.evaluate(() => { (window as any).refreshFixture(); (window as any).actionMode = "success"; });
      if (surface === "answer") {
        await page.getByRole("button", { name: "Close" }).click();
        await page.getByRole("link", { name: "Answer", exact: true }).click();
        await page.getByRole("dialog").locator("textarea").fill("Keep this draft");
      } else if (surface === "retry") {
        await page.evaluate(() => { location.hash = "#/needs-you"; });
        await page.locator(".ny-item").filter({ hasText: "Managed failed work" }).getByRole("link", { name: "Inspect failures" }).click();
        await page.getByRole("radio", { name: /^Retry task/ }).click();
      }
      await actionButton(page, surface).click();
      const actual = await calls(page);
      expect(actual).toHaveLength(2);
      expect(actual[0]).toEqual(expectedCall(surface));
      expect(actual[1].params.expect_rev).toBe(8);
      expect(actual[1].params.requestId).toBe(`${actual[1].params.id}.8.${surface === "answer" ? "answer" : "retry"}`);
    } finally { await page.close(); }
  }, 30000);
  test.skipIf(!browserPath)(`${surface}: unmount during a request does not affect the remounted view`, async () => {
    const page = await setup(surface, "hold");
    try {
      await actionButton(page, surface).click();
      await page.waitForFunction(() => typeof (window as any).releaseAction === "function");
      if (surface === "answer") await page.getByRole("button", { name: "Close" }).click();
      else if (surface === "retry") await page.evaluate(() => { location.hash = "#/needs-you"; });
      else await page.evaluate(() => (window as any).unmountFixture());
      await page.evaluate(() => (window as any).releaseAction());
      await page.waitForTimeout(100);
      if (surface === "retry") expect(page.url()).toContain("#/needs-you");
      if (surface === "tray") await page.evaluate(() => (window as any).mountFixture());
      if (surface === "answer") {
        await page.getByRole("link", { name: "Answer", exact: true }).click();
        await page.getByRole("dialog").locator("textarea").fill("Keep this draft");
      } else if (surface === "retry") {
        await page.locator(".ny-item").filter({ hasText: "Managed failed work" }).getByRole("link", { name: "Inspect failures" }).click();
        await page.getByRole("radio", { name: /^Retry task/ }).click();
      }
      await page.evaluate(() => { (window as any).actionMode = "success"; });
      await actionButton(page, surface).click();
      expect(await calls(page)).toHaveLength(2);
    } finally { await page.close(); }
  }, 30000);
}
