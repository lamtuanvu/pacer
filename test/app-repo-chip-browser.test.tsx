import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { renderToString } from "preact-render-to-string";
import { SearchPicker } from "../app/src/ds/SearchPicker";
import { DensityProvider } from "../app/src/ds/Density";

const browserPath = process.env.PACER_TEST_BROWSER;

test.skipIf(!browserPath)("repository chip centres its SVG chevron and keeps desktop and touch geometry", async () => {
  const styles = (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/styles.css"].map(path => Bun.file(path).text()))).join("\n");
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    for (const density of ["normal", "compact"] as const) {
      await page.setContent(`<style>${styles}</style>${renderToString(<DensityProvider value={density}><SearchPicker label="All repos · 1" searchLabel="Search repositories" placeholder="Search" emptyLabel="No repos" value={null} options={[]} onChange={() => {}} /></DensityProvider>)}`);
      const chip = page.getByRole("button", { name: "All repos · 1", exact: true });
      const geometry = await chip.evaluate(node => {
        const svg = node.querySelector("svg")!;
        const box = node.getBoundingClientRect();
        const icon = svg.getBoundingClientRect();
        const style = getComputedStyle(node);
        const reference = document.createElement("span");
        reference.style.color = "var(--ink-secondary)";
        node.append(reference);
        const expectedColour = getComputedStyle(reference).color;
        reference.remove();
        return { height: box.height, width: icon.width, iconHeight: icon.height,
          centre: icon.y + icon.height / 2 - box.y - box.height / 2,
          gap: style.gap, expectedGap: style.getPropertyValue("--space-1").trim(),
          colour: getComputedStyle(svg).color,
          expectedColour };
      });
      expect(geometry.height).toBe(32);
      expect(geometry.width).toBe(12);
      expect(geometry.iconHeight).toBe(12);
      expect(geometry.centre).toBe(0);
      expect(geometry.gap).toBe(geometry.expectedGap);
      expect(geometry.colour).toBe(geometry.expectedColour);
      expect(await chip.locator("svg").getAttribute("aria-hidden")).toBe("true");
      expect(await chip.locator("svg").getAttribute("viewBox")).toBe("0 0 24 24");
      expect(await chip.locator("svg").getAttribute("stroke-width")).toBe("1.8");
      expect(await chip.locator("path").getAttribute("d")).toBe("M6 9l6 6 6-6");
      await page.setViewportSize({ width: 375, height: 900 });
      expect(await chip.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  } finally { await browser.close(); }
});
