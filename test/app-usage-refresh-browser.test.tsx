import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpDir } from "./helpers";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser, server: ReturnType<typeof Bun.serve>;
const calls: string[] = [];
let refreshed = false;
let mode: "success" | "hold" | "fail" = "success";
let release: () => void = () => {};
let pending: Promise<void> = Promise.resolve();
const reading = (usedPct: number) => [{ name: "work", kind: "codex", usageReading: { windows: [{ name: "weekly", usedPct, resetsAt: null }], capturedAt: 1_799_999_900, stale: false, source: usedPct === 20 ? "session-log" : "provider-cli" } }];

beforeAll(async () => {
  if (!browserPath) return;
  const out = tmpDir();
  const built = Bun.spawn([process.execPath, "build", "test/fixtures/usage-refresh-browser.tsx", "--target", "browser", "--outdir", out], { stdout: "pipe", stderr: "pipe" });
  if (await built.exited) throw Error(await new Response(built.stderr).text());
  const script = await Bun.file(join(out, "usage-refresh-browser.js")).text();
  const styles = (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/styles.css"].map(path => Bun.file(path).text()))).join("\n");
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/ops/")) return new Response(`<div id="root"></div><style>${styles}</style><script type="module">${script}</script>`, { headers: { "Content-Type": "text/html" } });
    const op = path.slice(5);
    calls.push(op);
    if (op === "account.list") return Response.json(reading(refreshed ? 35 : 20));
    if (op === "limits.refresh") {
      if (mode === "hold") await pending;
      if (mode === "fail") return Response.json({ code: "internal", message: "Provider unavailable" }, { status: 500 });
      refreshed = true;
      return Response.json({ accounts: [{ account: "work", outcome: "updated" }] });
    }
    return Response.json({ code: "unknown_op", message: op }, { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15_000);
afterAll(async () => { server?.stop(true); await browser?.close(); }, 15_000);

browserTest("Usage refresh calls the v3 operation and reloads the displayed reading", async () => {
  calls.length = 0; refreshed = false; mode = "success";
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(String(server.url));
    await page.getByRole("button", { name: /Usage details/ }).click();
    await page.getByText("20%", { exact: true }).waitFor();
    const refreshButton = page.getByRole("button", { name: "Refresh usage" });
    await page.getByRole("button", { name: "Close" }).focus();
    await page.keyboard.press("Shift+Tab");
    expect(await refreshButton.evaluate(element => document.activeElement === element)).toBe(true);
    expect(await refreshButton.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
    const captures = process.env.PACER_USAGE_SCREENSHOT_DIR;
    if (captures) { mkdirSync(captures, { recursive: true }); await page.screenshot({ path: join(captures, "usage-before-refresh-1440.png") }); }
    await refreshButton.click();
    await page.getByRole("status").getByText("1 account updated.").waitFor();
    await page.getByText("35%", { exact: true }).waitFor();
    expect(calls).toEqual(["account.list", "limits.refresh", "account.list"]);
    expect(await page.getByText("Provider reading").count()).toBe(1);
    if (captures) await page.screenshot({ path: join(captures, "usage-after-refresh-1440.png") });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (captures) await page.screenshot({ path: join(captures, "usage-after-refresh-375.png") });
  } finally { await page.close(); }
}, 15_000);

browserTest("Usage refresh shows busy and error states without claiming an update", async () => {
  calls.length = 0; refreshed = false; mode = "hold";
  pending = new Promise(resolve => { release = resolve; });
  const page = await browser.newPage();
  try {
    await page.goto(String(server.url));
    await page.getByRole("button", { name: /Usage details/ }).click();
    const button = page.getByRole("button", { name: "Refresh usage" });
    await page.getByText("20%", { exact: true }).waitFor();
    await button.click();
    expect(await button.isDisabled()).toBe(true);
    expect(await button.getAttribute("aria-busy")).toBe("true");
    expect(calls.filter(op => op === "limits.refresh")).toHaveLength(1);
    mode = "fail"; release();
    await page.getByRole("alert").getByText("Could not refresh usage. Try again.").waitFor();
    expect(await button.isDisabled()).toBe(false);
    expect(await page.getByText("1 account updated.").count()).toBe(0);
    expect(await page.getByText("20%", { exact: true }).count()).toBe(1);
  } finally { release(); await page.close(); }
}, 15_000);
