import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!browserPath) return;
  const built = await Bun.build({ entrypoints: ["test/fixtures/ui/insights-browser.tsx"], target: "browser" });
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
      // The wide tables scroll inside their own focusable regions.
      for (const name of ["Agents table, scrollable", "Task kinds table, scrollable"]) {
        const region = page.getByRole("region", { name });
        expect(await region.evaluate(node => node.tabIndex)).toBe(0);
      }
    } finally { await page.close(); }
  });
}
