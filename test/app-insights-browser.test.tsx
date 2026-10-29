import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ["test/fixtures/ui/insights-browser.tsx"], target: "browser", plugins: [{ name: "measured-attempt-count", setup(builder) {
    builder.onLoad({ filter: /insights-browser\.tsx$/ }, async args => ({
      contents: (await Bun.file(args.path).text()).replace("measuredAttempts: 3", 'measuredAttempts: Number(new URLSearchParams(location.search).get("measured") ?? 3)'),
      loader: "tsx",
    }));
  } }] });
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  const styles = (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/ds/feedback.css", "app/src/styles.css", "app/src/screens/insights/insights.css"].map(path => Bun.file(path).text()))).join("\n");
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style><div id="root"></div><script type="module">${script}</script>`, { headers: { "Content-Type": "text/html" } }) });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); server?.stop(true); }, 30000);

for (const [width, scheme] of [[375, "light"], [375, "dark"], [768, "light"], [1440, "dark"]] as const) {
  browserTest(`Insights never scrolls the page sideways at ${width}px (${scheme})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
    try {
      await page.goto(`${server.url}`);
      await page.getByRole("heading", { name: "Agents, ranked by tokens" }).waitFor();
      const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
      // The board puts the title in the page; the shell's top bar omits its h1 here (pageOwnsTitle), so there is one.
      expect(await page.locator("h1").allTextContents()).toEqual(["Insights"]);
      const geometry = await page.locator(".pc-page--insights").evaluate(node => {
        const css = getComputedStyle(node);
        return { padding: css.padding, maxWidth: css.maxWidth, width: node.getBoundingClientRect().width };
      });
      expect(geometry.padding).toBe(width < 768 ? "16px 16px 24px" : "24px 32px 40px");
      expect(geometry.maxWidth).toBe("none");
      expect(geometry.width).toBe(width);
      const period = page.getByRole("group", { name: "Period" });
      const segments = await period.getByRole("button").evaluateAll(nodes => nodes.map(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return { lines: range.getClientRects().length, nowrap: getComputedStyle(node).whiteSpace };
      }));
      expect(segments.every(s => s.lines === 1 && s.nowrap === "nowrap")).toBe(true);
      // The wide tables scroll inside their own focusable regions.
      for (const name of ["Agents table, scrollable", "Task kinds table, scrollable"]) {
        const region = page.getByRole("region", { name });
        expect(await region.evaluate(node => node.tabIndex)).toBe(0);
      }
    } finally { await page.close(); }
  });
}

for (const measured of [1, 3]) {
  browserTest(`Insights keeps the table caption short and and pluralizes ${measured} measured attempts`, async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    try {
      await page.goto(`${server.url}?measured=${measured}`);
      await page.getByRole("heading", { name: "Agents, ranked by tokens" }).waitFor();
      const copy = await page.locator(".pc-insights__headline").textContent();
      expect(copy).toContain(`${measured} ${measured === 1 ? "attempt" : "attempts"} measured`);
      const captions = await page.locator(".pc-insights__caption").allTextContents();
      expect(captions).toContain("Distinct roots and subtasks · attempts ended in this period");
      expect(captions.some(text => text.includes("first settled"))).toBe(false);
    } finally { await page.close(); }
  });
}

for (const width of [375, 1440]) {
  browserTest(`Insights board geometry and readable day labels at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(String(server.url));
      await page.getByRole("heading", { name: "Agents, ranked by tokens" }).waitFor();
      const labels = await page.locator(".pc-insights__days li").evaluateAll(nodes => nodes.filter(n => getComputedStyle(n).visibility !== "hidden").map(n => {
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }));
      expect(labels).toHaveLength(width === 375 ? 7 : 14);
      for (let i = 1; i < labels.length; i++) expect(labels[i]!.left).toBeGreaterThanOrEqual(labels[i - 1]!.right);
      expect(await page.locator(".sr-only table tbody tr").count()).toBe(14);
      const buttons = await page.getByRole("group", { name: "Period" }).getByRole("button").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
      expect(buttons.every(h => h === (width === 375 ? 48 : 32))).toBe(true);
      const group = await page.getByRole("group", { name: "Period" }).evaluate(n => ({ padding: getComputedStyle(n).padding, radius: getComputedStyle(n).borderRadius }));
      expect(group).toEqual({ padding: "3px", radius: "8px" });
      const matrix = page.locator(".pc-insights__heat");
      expect(await matrix.locator("thead").textContent()).not.toContain("Kind");
      expect(await matrix.locator("tbody th").first().evaluate(n => n.getBoundingClientRect().width)).toBe(76);
      if (width === 1440) {
        expect(await page.locator(".pc-page--insights").evaluate(n => n.getBoundingClientRect().left)).toBe(0);
        const cols = await page.locator(".pc-insights__agents thead th").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().width));
        expect([cols[1], cols[2], cols[3], cols[4], cols[6], cols[7], cols[8]]).toEqual([70, 80, 70, 80, 90, 90, 110]);
        const header = await page.locator(".pc-insights__cardhead--bar").evaluate(n => Array.from(n.children).map(c => c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2));
        expect(header[0]).toBe(header[1]);
      }
    } finally { await page.close(); }
  });
}

for (const [width, height] of [[1440, 900], [1920, 1080]] as const) for (const scheme of ["light", "dark"] as const) {
  browserTest(`unmeasured insights shows exact attempt count, not zero tokens at ${width} ${scheme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
    try {
      await page.goto(`${server.url}?unmeasured`);
      await page.getByText("Token counts appear after each attempt finishes", { exact: true }).waitFor();
      expect(await page.locator(".pc-insights__unmeasured").textContent()).toContain("12 attempts are still running or ended without a count.");
      const tile = page.locator(".pc-insights__kpi").filter({ hasText: /^Tokens/ });
      expect(await tile.locator("strong").textContent()).toBe("—");
      expect(await tile.textContent()).toContain("not measured yet");
      const perRoot = page.locator(".pc-insights__kpi").filter({ hasText: /^Per root task/ });
      expect(await perRoot.textContent()).toContain("not measured yet");
      expect(await perRoot.textContent()).not.toContain("100%");
      expect(await page.locator(".pc-insights__unmeasured").evaluate(n => getComputedStyle(n).backgroundColor)).toBe(scheme === "dark" ? "rgb(24, 24, 27)" : "rgb(250, 250, 250)");
      if (process.env.PACER_DESIGN_EVIDENCE) await page.screenshot({ path: `.work/fixtures/states/insights-${width}-${scheme}.png`, fullPage: true });
    } finally { await page.close(); }
  });
}
