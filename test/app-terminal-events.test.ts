import { expect, test } from "bun:test";
import { chromium } from "playwright-core";

const browserTest = (name: string, run: () => Promise<void>) => test.skipIf(!process.env.PACER_TEST_BROWSER)(name, run);

async function open(announced: boolean) {
  const result = await Bun.build({ entrypoints: ["test/fixtures/terminal-events-browser.tsx"], target: "browser", format: "esm", tsconfig: "app/tsconfig.json" });
  expect(result.success).toBe(true);
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.route("http://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><div id=\"app\"></div>" }));
  await page.goto(`http://pacer.test/?announced=${announced ? "1" : "0"}#/terminal`);
  await page.clock.install();
  await page.addScriptTag({ type: "module", content: await result.outputs[0]!.text() });
  await page.getByRole("heading", { name: "Terminal", exact: true }).waitFor();
  const calls = () => page.evaluate(() => (window as any).terminalCalls.filter((op: string) => op === "terminal.list") as string[]);
  await page.waitForFunction(() => (window as any).terminalCalls.filter((op: string) => op === "terminal.list").length === 1);
  return { browser, page, calls };
}

browserTest("a terminal event refetches once, an unrelated event and 60 s idle do not", async () => {
  const { browser, page, calls } = await open(true);
  try {
    await page.clock.runFor(60_000);
    expect(await calls()).toHaveLength(1);
    await page.evaluate(() => (window as any).terminalEmit("config"));
    await page.waitForTimeout(50);
    expect(await calls()).toHaveLength(1);
    await page.evaluate(() => (window as any).terminalEmit("terminal"));
    await page.waitForTimeout(50);
    expect(await calls()).toHaveLength(2);
    await page.evaluate(() => (window as any).terminalReconnect());
    await page.waitForTimeout(50);
    expect(await calls()).toHaveLength(3);
  } finally { await browser.close(); }
});

browserTest("a service without the terminal event keeps the two-second fallback poll", async () => {
  const { browser, page, calls } = await open(false);
  try {
    await page.clock.runFor(4_200);
    expect((await calls()).length).toBeGreaterThanOrEqual(3);
  } finally { await browser.close(); }
});
