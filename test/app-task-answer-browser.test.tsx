import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it this check skips.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);

async function build() {
  const out = await Bun.build({ entrypoints: ["test/fixtures/session-screen-browser.tsx"], target: "browser", splitting: false, plugins: [{ name: "stub-pty-view", setup(builder) {
    builder.onResolve({ filter: /term\/LazyTerminal$/ }, () => ({ path: "stub", namespace: "terminal-stub" }));
    builder.onLoad({ filter: /.*/, namespace: "terminal-stub" }, () => ({ contents: "import { h } from 'preact'; export const LazyTerminal = () => h('div', { className: 'pc-terminal-stub', tabIndex: 0, 'aria-label': 'Agent terminal' });", loader: "js" }));
  } }] });
  expect(out.success).toBe(true);
  const css = [generateTokensCss(readTokens("app/src/ds")), ...await Promise.all(["app/src/ds/components.css", "app/src/ds/feedback.css", "app/src/styles.css", "app/src/screens/session/session.css"].map(path => Bun.file(path).text()))].join("\n");
  return { source: await out.outputs[0]!.text(), css };
}
const focused = (page: Page, selector: string) => page.waitForFunction(at => document.activeElement?.matches(at), selector, { timeout: 2000 })
  .catch(async error => { throw new Error(`${error.message}; focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))}`); });

browserTest("a running task's answer link lands on a focused composer that sends a msg.send answer", async () => {
  const { source, css } = await build();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("https://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>session</title><div id="app"></div>' }));
    // A secure origin, like the app's, gives the composer crypto.randomUUID. The tray's deep link redirects the way the app router does.
    await page.goto("https://pacer.test/#/sessions/t-0412/answer");
    await page.evaluate(css => { document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`); (window as any).SCENARIO = "asked"; }, css);
    await page.evaluate(async code => { const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })); await import(url); URL.revokeObjectURL(url); }, source);
    await page.locator(".pc-session-bar").first().waitFor({ state: "attached" });
    expect(page.url()).toContain("#/tasks/t-0412?tab=answer");
    const panel = page.getByRole("complementary", { name: "Session details" });
    expect(await panel.getByRole("tab", { name: "Details", exact: true }).getAttribute("aria-selected")).toBe("true");
    await panel.getByText("Which provider should the flow use?").waitFor();
    const box = panel.getByRole("textbox", { name: "Your answer" });
    await focused(page, ".pc-session-details textarea");
    // The settled result stays hidden while the task runs; only the answer path shows.
    expect(await panel.getByRole("button", { name: "Mark accepted", exact: true }).count()).toBe(0);
    await page.keyboard.type("Use Stripe");
    await page.keyboard.press("Tab");
    await focused(page, ".pc-session-details .pc-btn--primary");
    await page.keyboard.press("Enter");
    await panel.getByRole("status").filter({ hasText: "Answer sent. The task is continuing." }).waitFor();
    const call = await page.evaluate(() => (window as any).CALLS.find((c: any) => c.op === "msg.send"));
    expect(call.params).toMatchObject({ to: "task:t-0412", kind: "answer", reply_to: "m-1", body: "Use Stripe" });
    // The read question leaves the panel once the task reloads.
    await box.waitFor({ state: "detached" });
  } finally { await browser.close(); }
}, 30000);
