import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { renderToString } from "preact-render-to-string";
import { PanelTabs, type PanelTab } from "../app/src/ds/PanelTabs";
import { tabStep } from "../app/src/ds/Patterns";

// Keyboard and focus checks run in Chrome when PACER_TEST_BROWSER points to it; markup checks always run.
const browserPath = process.env.PACER_TEST_BROWSER;
const tabs: PanelTab[] = ["Summary", "Files", "Checks", "Logs", "Notes", "History"].map(label => ({ id: label.toLowerCase(), label }));
const render = (value: string, extra: Partial<PanelTab>[] = []) => renderToString(<PanelTabs label="Task details" value={value} onChange={() => {}}
  tabs={tabs.map((tab, at) => ({ ...tab, ...extra[at] }))} />);

async function withTabs(run: (page: Page) => Promise<void>) {
  const build = await Bun.build({ entrypoints: ["test/fixtures/panel-tabs-browser.tsx"], target: "browser", splitting: false });
  expect(build.success).toBe(true);
  const styles = await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css"].map(path => Bun.file(path).text()));
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${styles.join("\n")}</style><div id="app"></div>`);
    await page.evaluate(async code => { const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })); await import(url); URL.revokeObjectURL(url); }, await build.outputs[0]!.text());
    await page.getByRole("tablist", { name: "Task details" }).waitFor();
    await run(page);
  } finally { await browser.close(); }
}
const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim());

test("tabs_roving_tabindex_and_arrow_keys", async () => {
  const html = render("files");
  expect(html).toContain('role="tablist" aria-label="Task details"');
  expect(html.match(/role="tab"/g)?.length).toBe(4);
  expect(html.match(/tabindex="0"/g)?.length).toBe(1);
  expect(html).toMatch(/role="tab" aria-selected="true" tabindex="0"[^>]*>(?:<[^>]+>)*Files/);
  expect(html.match(/role="tab" aria-selected="false" tabindex="-1"/g)?.length).toBe(3);
  // Shared with Tabs: wrap at both ends, Home and End jump, other keys do nothing.
  expect([tabStep("ArrowRight", 3, 4), tabStep("ArrowLeft", 0, 4), tabStep("Home", 2, 4), tabStep("End", 0, 4), tabStep("a", 1, 4)]).toEqual([0, 3, 0, 3, undefined]);
  if (!browserPath) return;
  await withTabs(async page => {
    await page.getByRole("tab", { name: "Summary" }).focus();
    for (const [key, name] of [["ArrowRight", "Files"], ["End", "Logs"], ["ArrowRight", "Summary"], ["ArrowLeft", "Logs"], ["Home", "Summary"]] as const) {
      await page.keyboard.press(key);
      expect(await focusedText(page)).toStartWith(name);
      expect(await page.locator("#value").textContent()).toBe(name.toLowerCase());
      expect(await page.getByRole("tab", { name, exact: true }).getAttribute("tabindex")).toBe("0");
    }
  });
}, 20_000);

test("tabs_overflow_into_menu", async () => {
  const html = render("summary");
  expect(html).toMatch(/aria-label="\+2 more tabs" aria-haspopup="menu" aria-expanded="false"/);
  expect(html).not.toContain(">Notes<");
  // The selected tab is never hidden: it takes the last visible slot.
  const selectedHidden = render("history");
  expect(selectedHidden).toMatch(/aria-selected="true"[^>]*>(?:<[^>]+>)*History/);
  expect(selectedHidden).not.toContain(">Logs<");
  expect(renderToString(<PanelTabs label="Few" tabs={tabs.slice(0, 4)} value="summary" onChange={() => {}} />)).not.toContain("more tabs");
  expect(renderToString(<PanelTabs label="Two" tabs={tabs} value="summary" maxVisible={2} onChange={() => {}} />)).toContain('aria-label="+4 more tabs"');
  if (!browserPath) return;
  await withTabs(async page => {
    await page.getByRole("button", { name: "+2 more tabs" }).click();
    const menu = page.getByRole("menu", { name: "More Task details" });
    await expect(menu.getByRole("menuitem").allTextContents()).resolves.toEqual(["Notes", "History"]);
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
    await page.keyboard.press("ArrowDown");
    expect(await focusedText(page)).toBe("History");
    await page.keyboard.press("Enter");
    await expect(menu.count()).resolves.toBe(0);
    expect(await page.locator("#value").textContent()).toBe("history");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-selected") === "true");
    expect(await focusedText(page)).toBe("History");
  });
}, 20_000);

test("overflow_menu_escape_returns_focus", async () => {
  if (!browserPath) return;
  await withTabs(async page => {
    const more = page.getByRole("button", { name: "+2 more tabs" });
    await more.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
    await expect(more.getAttribute("aria-expanded")).resolves.toBe("true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu").count()).resolves.toBe(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("+2 more tabs");
    expect(await page.locator("#value").textContent()).toBe("summary");
  });
}, 20_000);

test("badge_has_words", () => {
  const html = render("summary", [{}, { badge: 1 }, { badge: 3 }]);
  expect(html).toContain('aria-label="1 item"');
  expect(html).toContain('aria-label="3 items"');
  expect(html).toMatch(/aria-label="3 items" class="pc-count-badge">3</);
  expect(render("summary", [{ badge: 0 }])).not.toContain("pc-count-badge");
});
