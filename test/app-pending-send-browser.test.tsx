import { expect, test } from "bun:test";

test.skipIf(!process.env.PACER_TEST_BROWSER)("Thread restores composer focus after Discard and Retry confirmation", async () => {
  const { chromium } = await import("playwright-core");
  const build = await Bun.build({ entrypoints: ["test/fixtures/pending-send-browser.tsx"], target: "browser" });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div>' }));
    await page.goto("https://pacer.test/");
    await page.addScriptTag({ content: await build.outputs[0]!.text(), type: "module" });
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Keep this draft");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    expect(await composer.inputValue()).toBe("Keep this draft");
    expect(await composer.evaluate(node => node === document.activeElement)).toBe(true);
    // The second send confirms directly; the third fails and exposes Retry.
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    await composer.fill("Retry this draft");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Your pending message"]'));
    expect(await composer.evaluate(node => node === document.activeElement)).toBe(true);
  } finally { await browser.close(); }
}, 30000);
