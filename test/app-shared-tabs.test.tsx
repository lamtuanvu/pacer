import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { checkUiSource } from "../scripts/ui-check";

const browserPath = process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)("shared strip measures, slides, resizes, roves focus and cross-fades without collapsing", async () => {
  const build = await Bun.build({ entrypoints: ["test/fixtures/shared-tabs-browser.tsx"], target: "browser" });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const styles = (await Promise.all(["tokens.css", "components.css"].map(file => Bun.file(`app/src/ds/${file}`).text()))).join("\n");
    await page.setContent(`<style>${styles}</style><div id="root"></div>`);
    await page.addScriptTag({ content: await build.outputs[0]!.text(), type: "module" });
    const group = page.getByRole("group", { name: "Scope" });
    await page.waitForFunction(() => document.querySelector('[aria-label="Scope"]')?.getAttribute("data-measured") === "true");
    const marker = group.locator(".pc-selection-indicator");
    const geometry = async () => ({ indicator: await marker.boundingBox(), button: await group.locator('[aria-pressed="true"]').boundingBox() });
    let boxes = await geometry();
    expect(Math.abs(boxes.indicator!.x - boxes.button!.x)).toBeLessThan(1);
    expect(boxes.indicator!.width).toBe(boxes.button!.width);
    expect((await group.boundingBox())!.height).toBe(38);
    expect(boxes.button!.height).toBe(30);
    expect(await marker.evaluate(el => el.getAnimations().length)).toBe(0);
    await group.getByRole("button", { name: "One repository" }).click();
    await page.waitForTimeout(190);
    boxes = await geometry();
    expect(Math.abs(boxes.indicator!.x - boxes.button!.x)).toBeLessThan(1);
    expect(boxes.indicator!.width).toBe(boxes.button!.width);
    await group.getByRole("button", { name: "One repository" }).evaluate(el => el.textContent = "One much longer repository label");
    await page.waitForTimeout(220);
    boxes = await geometry(); expect(boxes.indicator!.width).toBe(boxes.button!.width);
    await page.keyboard.press("ArrowRight");
    expect(await group.getByRole("button", { name: "All repositories" }).getAttribute("aria-pressed")).toBe("true");
    await page.keyboard.press("End");
    expect(await group.locator('[aria-pressed="true"]').getAttribute("tabindex")).toBe("0");
    const swap = (key: string) => page.evaluate(key => new Promise<{count:number;inert:boolean;closed:boolean;duration:string;height:number}>(resolve => {
      const list = document.querySelector<HTMLElement>('[aria-label="Session details"]')!;
      const observer = new MutationObserver(() => {
        observer.disconnect();
        const ghost = document.querySelector<HTMLElement>(".pc-tab-leave");
        const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
        resolve({count:ghost ? 1 : 0,inert:ghost?.hasAttribute("inert") ?? false,closed:ghost?.shadowRoot === null,
          duration:getComputedStyle(panel).animationDuration,height:panel.parentElement!.getBoundingClientRect().height});
      });
      observer.observe(list,{subtree:true,attributes:true,attributeFilter:["aria-selected"]});
      const selected = list.querySelector<HTMLElement>('[aria-selected="true"]')!;
      selected.focus(); selected.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
    }), key);
    // Observe the swap in one browser turn: a 120ms animation can finish between
    // separate protocol round trips on a busy CI host.
    const fading = await swap("ArrowRight");
    await page.waitForFunction(() => document.querySelector('[id="session-changes-tab"]')?.getAttribute("aria-selected") === "true");
    expect(await page.getByRole("tab", { name: "Changes", exact: true }).getAttribute("aria-selected")).toBe("true");
    expect(await page.getByRole("tab", { name: "Changes", exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
    expect(fading.count).toBe(1);
    expect(fading.duration).toBe("0.12s");
    expect(fading.inert).toBe(true);
    expect(fading.closed).toBe(true);
    const height = fading.height;
    await page.waitForTimeout(240);
    expect(await page.locator(".pc-tab-leave").count()).toBe(0);
    expect((await page.getByTestId("Session details").boundingBox())!.height).toBeGreaterThanOrEqual(height - 1);
    const keyboard = page.getByRole("group", { name: "Keyboard choices" });
    await keyboard.getByRole("button", { name: "First" }).focus();
    await page.keyboard.press("ArrowRight");
    expect(await keyboard.getByRole("button", { name: "Last" }).getAttribute("aria-pressed")).toBe("true");
    await page.keyboard.press("Home");
    expect(await keyboard.getByRole("button", { name: "First" }).getAttribute("aria-pressed")).toBe("true");
    const shrinking = await swap("ArrowLeft");
    expect(shrinking.height).toBeGreaterThanOrEqual(height - 1);
    await page.waitForTimeout(160);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("ArrowRight");
    expect(await page.locator(".pc-tab-leave").count()).toBe(0);
    expect(await marker.evaluate(el => getComputedStyle(el).transitionDuration)).toBe("0s");
    expect(await page.getByRole("tabpanel").evaluate(el => el.getAnimations().length)).toBe(0);
  } finally { await browser.close(); }
}, 60000);

test("measured strip adapter rejects arbitrary dimensions and neighboring styles", () => {
  const path = "app/src/ds/SelectionStrip.tsx";
  expect(checkUiSource(path, 'marker.style.width = `${selected.getBoundingClientRect().width}px`;')).toEqual([]);
  expect(checkUiSource(path, 'marker.style.height = `${selected.getBoundingClientRect().height}px`;')).toEqual([]);
  for (const source of ['marker.style.width = `${size}px`;', 'marker.style.padding = `${selected.getBoundingClientRect().width}px`;', 'other.style.width = `${selected.getBoundingClientRect().width}px`;']) expect(checkUiSource(path, source).some(v => v.rule === "UI-21")).toBe(true);
  expect(checkUiSource("app/src/ds/Other.tsx", 'marker.style.width = `${selected.getBoundingClientRect().width}px`;').some(v => v.rule === "UI-21")).toBe(true);
});
