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
      expect(geometry.padding).toBe("28px 40px 48px");
      expect(geometry.maxWidth).toBe("1240px");
      expect(geometry.width).toBeLessThanOrEqual(1240);
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
  browserTest(`Insights explains the task count cohorts and pluralizes ${measured} measured attempts`, async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    try {
      await page.goto(`${server.url}?measured=${measured}`);
      await page.getByRole("heading", { name: "Agents, ranked by tokens" }).waitFor();
      const copy = await page.locator(".pc-insights__headline").textContent();
      expect(copy).toContain(`${measured} ${measured === 1 ? "attempt" : "attempts"} measured`);
      const captions = await page.locator(".pc-insights__caption").allTextContents();
      expect(captions).toContain("Root tasks count roots first settled in this period; subtasks count all tasks split from those roots.");
      expect(captions.some(text => text.includes("Counts below use attempts ended in this period") && text.includes("roots still running or first settled in another period") && text.includes("a root can appear for several agents"))).toBe(true);
    } finally { await page.close(); }
  });
}
