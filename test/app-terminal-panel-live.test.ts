import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { buildApp } from "../app/build";
import { resolveLoginShell } from "../src/terminal/login-shell";
import { basename } from "node:path";

const login = process.env.PACER_TERMINAL_TEST_URL;
// Only a one-use login from `live up --seed ui`; browser assets use this checkout's fresh build.
test.skipIf(!login || !process.env.PACER_TEST_BROWSER)("live panel creates one account login shell through every entry point", async () => {
  const files = new Map((await buildApp()).map(file => [file.path, file]));
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  const output = process.env.PACER_TERMINAL_SCREENSHOTS;
  if (output) mkdirSync(output, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/app/**", route => {
      const file = files.get(new URL(route.request().url()).pathname.slice(5));
      return file && file.path !== "index.html" ? route.fulfill({ contentType: file.type, body: file.text }) : route.continue();
    });
    const page = await context.newPage();
    await page.goto(login!);
    await page.getByRole("heading", { name: "Dispatch", exact: true }).waitFor();
    const capture = async (name: string) => {
      if (!output) return;
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({ path: `${output}/${name}-${colorScheme}.png` });
      }
      await page.emulateMedia({ colorScheme: "light" });
    };
    await capture("before");
    const shell = basename(resolveLoginShell(process.env));
    const panel = page.getByRole("region", { name: "Terminal panel", exact: true });
    const tab = panel.getByRole("tab", { name: shell, exact: true });
    const entries = [
      () => page.getByRole("button", { name: "Toggle terminal panel (Ctrl+`)" }).click(),
      () => page.keyboard.press("Control+Backquote"),
      () => page.getByRole("button", { name: "Terminal", exact: true }).click(),
      () => page.getByRole("link", { name: "Terminal panel (Ctrl+`)" }).click(),
    ];
    for (const open of entries) {
      await open();
      await tab.waitFor();
      await panel.locator('.pc-terminal-view[data-session-control="true"]').waitFor();
      expect(await panel.getByRole("tab").count()).toBe(1);
      // The reused shell receives focus after attachment, ready for typing.
      await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea"));
      await capture(`one-${entries.indexOf(open)}-${shell}`);
      await panel.getByRole("button", { name: "Hide panel (Ctrl+`)" }).click();
      await open();
      await tab.waitFor();
      expect(await panel.getByRole("tab").count()).toBe(1);
      await panel.getByRole("button", { name: "Kill terminal", exact: true }).click();
      await page.getByRole("button", { name: "Stop and close" }).click();
      await panel.getByText("No terminals open", { exact: true }).waitFor();
      await page.waitForTimeout(2200);
      expect(await panel.getByRole("tab").count()).toBe(0);
      expect(await panel.getByRole("button", { name: "New terminal", exact: true }).isEnabled()).toBe(true);
      await capture(`empty-${entries.indexOf(open)}`);
      await panel.getByRole("button", { name: "Hide panel (Ctrl+`)" }).click();
    }
    const records = await page.evaluate(async () => (await (await fetch("/v3/ops/terminal.list", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Pacer-Client": "app" }, body: "{}",
    })).json()).result);
    expect(records).toEqual([]);
  } finally { await browser.close(); }
}, 60_000);
