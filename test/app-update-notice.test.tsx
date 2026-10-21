import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { updateNotice, updateNoticeKey } from "../src/view-model/updates";
import { UpdateNoticeCard } from "../app/src/ds/UpdateNoticeCard";
import { desktopStatus } from "./fixtures/desktop-update/status";

test("notice offers only a ready, authorized version and respects per-installation dismissal", () => {
  const ready = desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart"] });
  expect(updateNotice([ready], new Set())).toEqual(ready);
  expect(updateNotice([ready], new Set([updateNoticeKey(ready)]))).toBeNull();
  expect(updateNotice([{ ...ready, revision: 2 }], new Set([updateNoticeKey(ready)]))).toBeNull();
  expect(updateNotice([{ ...ready, target: "0.2.5" }], new Set([updateNoticeKey(ready)]))).not.toBeNull();
  for (const status of [{ ...ready, phase: "downloading" as const }, { ...ready, target: null }, { ...ready, actions: [] }]) expect(updateNotice([status], new Set())).toBeNull();
});

test("notice uses an accessible nonmodal panel and explicit restart/later controls", () => {
  const html = renderToString(<UpdateNoticeCard version="0.2.4" restart={() => {}} later={() => {}} busy={false}/>);
  expect(html).toContain("Update ready");
  expect(html).toContain("0.2.4");
  expect(html).toContain("Restart to update");
  expect(html).toContain("Later");
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain("autofocus");
});

const browserPath = process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)("mounted notice preserves explicit consent, stale guards, dismissal and pending/error focus", async () => {
  const { chromium } = await import("playwright-core");
  const build = await Bun.build({ entrypoints: ["test/fixtures/ui/update-notice-browser.tsx"], target: "browser" });
  expect(build.success).toBe(true);
  const script = await build.outputs[0]!.text();
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 700 } });
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => console.error(error.message));
    const styles = await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css"].map(path => Bun.file(path).text()));
    await page.route("http://localhost/update-notice-fixture", route => route.fulfill({ contentType: "text/html", body: `<style>${styles.join("\n")}</style><div id="app"></div><script type="module">${script}</script>` }));
    const mount = async () => { await page.goto("http://localhost/update-notice-fixture"); await page.getByRole("button", { name: "Later", exact: true }).waitFor(); };
    const confirm = async () => { await page.getByRole("button", { name: "Restart to update", exact: true }).click(); await page.getByRole("dialog").waitFor(); };
    await mount();
    expect(await page.evaluate(() => (window as any).calls.length)).toBe(0);
    const box = await page.getByRole("complementary", { name: "Desktop update" }).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(375); expect(box!.y + box!.height).toBeLessThanOrEqual(628);
    await page.getByRole("button", { name: "Later", exact: true }).click();
    expect(await page.getByRole("complementary").count()).toBe(0);
    expect(await page.locator("#main-content").evaluate(node => node === document.activeElement)).toBe(true);
    await page.evaluate(() => (window as any).update({ revision: 2 }));
    expect(await page.getByRole("complementary").count()).toBe(0);
    await page.evaluate(() => (window as any).update({ target: "0.2.5", revision: 3 }));
    await page.getByRole("button", { name: "Later", exact: true }).waitFor();
    await confirm(); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.evaluate(() => (window as any).calls.length)).toBe(0);
    await confirm(); await page.evaluate(() => (window as any).update({ revision: 4 }));
    await page.getByRole("dialog").getByRole("button", { name: "Restart to update", exact: true }).click();
    expect(await page.evaluate(() => (window as any).calls.length)).toBe(0);
    await confirm(); await page.evaluate(() => (window as any).capability(false));
    await page.getByRole("dialog").getByRole("button", { name: "Restart to update", exact: true }).click();
    expect(await page.evaluate(() => (window as any).calls.length)).toBe(0);
    await page.evaluate(() => (window as any).capability(true));
    await confirm(); await page.getByRole("dialog").getByRole("button", { name: "Restart to update", exact: true }).click();
    await page.waitForFunction(() => (window as any).calls.length === 1);
    const restart = page.getByRole("button", { name: "Restart to update", exact: true });
    expect(await restart.getAttribute("aria-disabled")).toBe("true");
    expect(await restart.evaluate(node => node === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (window as any).calls.length)).toBe(1);
    await page.evaluate(() => (window as any).fail());
    await page.getByText("Update request failed").waitFor();
    expect(await restart.evaluate(node => node === document.activeElement)).toBe(true);
    expect(await restart.getAttribute("aria-disabled")).toBe("false");
    await confirm(); await page.getByRole("dialog").getByRole("button", { name: "Restart to update", exact: true }).click();
    await page.waitForFunction(() => (window as any).calls.length === 2);
    const sent = await page.evaluate(() => (window as any).calls[1]);
    expect(sent.op).toBe("desktop.update.restart");
    expect(sent.params).toMatchObject({ installationId: "desktop-fixture", version: "0.2.5", expectRevision: 4 });
    await page.evaluate(() => (window as any).finish());
    await page.getByRole("complementary").waitFor({ state: "detached" });
    await page.evaluate(() => (window as any).update({ target: "0.2.6", revision: 5 }));
    await confirm(); await page.evaluate(() => (window as any).connection(false));
    await page.getByRole("dialog").getByRole("button", { name: "Restart to update", exact: true }).click();
    expect(await page.evaluate(() => (window as any).calls.length)).toBe(2);
    await page.evaluate(() => (window as any).connection(true));
    await confirm(); await page.evaluate(() => (window as any).hide(true));
    await page.getByRole("dialog").getByRole("button", { name: "Restart to update", exact: true }).click();
    expect(await page.evaluate(() => (window as any).calls.length)).toBe(2);
  } finally { await browser.close(); }
}, 30_000);
