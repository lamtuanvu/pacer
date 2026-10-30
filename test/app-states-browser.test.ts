import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { mkdirSync } from "node:fs";
const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let outage = false, eventFailures = 0;
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let eventRequests = 0;
beforeAll(async () => {
  if (!process.env.PACER_TEST_BROWSER) return;
  const built = await Bun.build({ entrypoints: ["test/fixtures/ui/app-states.tsx"], target: "browser" });
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  const css = (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/ds/feedback.css", "app/src/styles.css"].map(p => Bun.file(p).text()))).join("\n");
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/v3/")) {
      if (outage) return new Response("Unavailable", { status: 502 });
      if (path === "/v3/events") {
        eventRequests++;
        if (eventFailures-- > 0) return new Response("Bad Gateway", { status: 502 });
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(": connected\n\n")); }, cancel() { stream = undefined; } }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (path === "/v3/hello") return Response.json({ pacer: "test", protocol: "3.0.0", ops: [], events: ["attention"] });
      if (path.startsWith("/v3/ops/")) return Response.json({ result: {} });
      if (path === "/v3/snapshot") return Response.json({ seq: 120, snapshot: await Bun.file("test/fixtures/ui/snapshot.json").json() });
    }
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script type="module">${script}</script>`, { headers: { "Content-Type": "text/html" } }); } });
  browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
for (const [width, height] of [[1440, 900], [1920, 1080], [390, 844], [560, 900]] as const) for (const scheme of ["light", "dark"] as const) {
  browserTest(`app states at ${width}×${height} ${scheme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
    try {
      for (const state of ["first", "empty", "offline", "normal", "sample"]) {
        await page.goto(`${server.url}?state=${state}`);
        await page.locator(".pc-dispatch").waitFor();
        await page.waitForFunction(() => document.adoptedStyleSheets.length > 0);
        expect(await page.locator("h1").allTextContents()).toEqual(["Dispatch"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (state === "first") {
          expect(await page.getByRole("link", { name: "Set up delegation" }).getAttribute("href")).toBe("#/settings/dispatcher");
          expect(await page.getByRole("link", { name: "Add another agent" }).getAttribute("href")).toBe("#/settings/add-executor");
          expect(await page.getByText("Found", { exact: true }).count()).toBe(1);
          expect(await page.getByRole("link", { name: "How to get it" }).getAttribute("title")).toBe("Install Cursor CLI");
        }
        if (state === "empty") {
          await page.getByText("No work delegated yet", { exact: true }).waitFor();
          expect(await page.getByText("Try a sample task").count()).toBe(0);
          expect(await page.locator(".pc-empty-dispatch").evaluate(n => getComputedStyle(n).borderStyle)).toBe("dashed");
        }
        if (state === "offline") {
          expect(await page.locator(".connection-bar").textContent()).toContain("Last update 1m ago. Running tasks keep going");
          expect(await page.locator(".pc-main").evaluate(n => getComputedStyle(n).opacity)).toBe("1");
          const contrast = await page.locator(".pc-dispatch-caption").first().evaluate(n => {
            const values = (s: string) => s.match(/[\d.]+/g)!.slice(0, 3).map(Number);
            const ink = values(getComputedStyle(n).color), bg = values(getComputedStyle(document.body).backgroundColor);
            const luminance = (rgb: number[]) => rgb.map(c => { const x = c / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i]!, 0);
            const fgL = luminance(ink), bgL = luminance(bg);
            return (Math.max(fgL, bgL) + .05) / (Math.min(fgL, bgL) + .05);
          });
          expect(contrast).toBeGreaterThanOrEqual(4.5);
          expect(await page.getByRole("button", { name: "Restart pacer", exact: true }).count()).toBe(0);
          const banner = await page.locator(".connection-bar").boundingBox(), top = await page.locator(".pc-topbar").boundingBox();
          expect(banner!.y).toBe(top!.y + top!.height);
          if (width > 560) {
            const rail = await page.locator(".pc-rail").boundingBox(), body = await page.locator(".pc-body").boundingBox();
            const status = await page.locator(".pc-statusbar").boundingBox();
            expect(body!.y).toBe(banner!.y + banner!.height);
            expect(rail!.y + rail!.height).toBeLessThanOrEqual(status!.y);
            const settings = page.getByRole("link", { name: /^Settings/ });
            const box = await settings.boundingBox();
            expect(box!.y + box!.height).toBeLessThanOrEqual(status!.y);
            await settings.click();
            expect(new URL(page.url()).hash).toBe("#/settings");
          }
          const serviceAction = page.getByRole("button", { name: "Offline service action" });
          expect(await serviceAction.isDisabled()).toBe(true);
          expect(await serviceAction.locator("xpath=ancestor::fieldset").getAttribute("title")).toBe("pacer is offline");
          expect(await page.getByRole("button", { name: "Direct service submit" }).isDisabled()).toBe(true);
          expect(await page.getByRole("button", { name: "Assistant service send" }).isDisabled()).toBe(true);
        }
        if (state === "normal") {
          await page.keyboard.press("Tab");
          expect(await page.locator(".skip-link").evaluate(n => n === document.activeElement)).toBe(true);
          await page.keyboard.press("Enter");
          expect(await page.locator("#main-content").evaluate(n => n === document.activeElement)).toBe(true);
        }
        if (state === "sample") {
          await page.getByRole("button", { name: "Try a sample task" }).click();
          await page.waitForFunction(() => location.hash === "#/tasks/sample-task");
        }
        if (width <= 560) {
          for (const h of await page.locator(".pc-first-run__actions>.pc-btn").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
          expect(await page.locator(".pc-bottom-bar a").allTextContents()).toEqual(["Dispatch", "Needs you4", "Tasks", "Insights", "Settings"]);
          expect(await page.locator(".pc-topbar").evaluate(n => n.getBoundingClientRect().height)).toBe(48);
          for (const label of ["Search", "New task"]) expect(await page.getByRole("button", { name: label, exact: true }).evaluate(n => n.getBoundingClientRect().height)).toBe(44);
          if (state === "normal") {
            const sections = await page.locator(".pc-dispatch>section").evaluateAll(nodes => nodes.map(n => n.getAttribute("aria-label") ?? n.getAttribute("aria-labelledby")));
            expect(sections).toEqual(["Planner budget", "needs-you", "running-title"]);
            await page.getByRole("button", { name: "Search", exact: true }).click();
            expect(await page.evaluate(() => document.body.dataset.search)).toBe("open");
            await page.getByRole("button", { name: "New task", exact: true }).click();
            expect(new URL(page.url()).hash).toBe("#/tasks/new");
          }
        }
        if (process.env.PACER_DESIGN_EVIDENCE) {
          const dir = ".work/fixtures/states"; mkdirSync(dir, { recursive: true });
          await Bun.write(`${dir}/${state}-${width}-${scheme}.json`, JSON.stringify(await page.evaluate(() => {
            const css = getComputedStyle(document.querySelector(".pc-dispatch")!), h = getComputedStyle(document.querySelector("h1")!);
            return { pagePadding: css.padding, maxWidth: css.maxWidth, heading: `${h.fontSize}/${h.lineHeight}`, topHeight: document.querySelector(".pc-topbar")!.getBoundingClientRect().height, ctaHeights: [...document.querySelectorAll(".pc-first-run__actions>.pc-btn")].map(n => n.getBoundingClientRect().height), cardRadius: document.querySelector(".pc-empty-dispatch") ? getComputedStyle(document.querySelector(".pc-empty-dispatch")!).borderRadius : null };
          }), null, 2));
          await page.screenshot({ path: `${dir}/${state}-${width}-${scheme}.png`, fullPage: true });
        }
      }
    } finally { await page.close(); }
  });
}

browserTest("DispatchHome uses detection and capability-gates sample work", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${server.url}?state=home-first`);
    await page.getByText("detected-version", { exact: true }).waitFor();
    expect(await page.evaluate(() => document.body.dataset.detectOp)).toBe("agent.detect");
    expect(await page.getByText("Found", { exact: true }).count()).toBe(1);
    await page.goto(`${server.url}?state=home-empty`);
    await page.getByText("No work delegated yet", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Try a sample task" }).count()).toBe(0);
    await page.goto(`${server.url}?state=home-sample`);
    await page.getByRole("button", { name: "Try a sample task" }).click();
    await page.waitForFunction(() => location.hash === "#/tasks/sample-task");
    expect(await page.evaluate(() => document.body.dataset.sampleOp)).toBe("onboarding.try");
  } finally { await page.close(); }
});


browserTest("HTTP 502 during restart retries and removes the offline banner on recovery", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const eventsReady = page.waitForResponse(response => new URL(response.url()).pathname === "/v3/events" && response.status() === 200);
    await page.goto(`${server.url}?state=recovery`);
    await eventsReady;
    const action = page.getByRole("button", { name: "Offline service action" });
    await page.waitForFunction(() => !document.querySelector(".connection-bar"));
    expect(await action.isEnabled()).toBe(true);
    const initialRequests = eventRequests;
    outage = true;
    stream!.close(); stream = undefined;
    await page.locator(".connection-bar").waitFor();
    expect(await action.isDisabled()).toBe(true);
    // Allow the first refresh to see the proxy's HTTP error.
    await page.waitForTimeout(1200);
    outage = false; eventFailures = 1;
    await page.waitForFunction(() => !document.querySelector(".connection-bar"), undefined, { timeout: 15000 });
    expect(eventRequests).toBeGreaterThanOrEqual(initialRequests + 2);
    expect(await action.isEnabled()).toBe(true);
    expect(await action.locator("xpath=ancestor::fieldset").getAttribute("title")).not.toBe("pacer is offline");
    expect(await page.getByRole("button", { name: "Direct service submit" }).isEnabled()).toBe(true);
  } finally { outage = false; eventFailures = 0; await page.close(); }
});


browserTest("Layout gates its separate UI API client and reenables it on reconnect", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let writes = 0;
  page.on("request", req => { if (req.url().includes("/ops/task.answer")) writes++; });
  try {
    await page.goto(`${server.url}?state=layout-probe`);
    await page.getByText("Guard probe").waitFor();
    await page.getByRole("button", { name: "Probe bypass" }).click();
    await page.waitForFunction(() => document.body.dataset.probe === "pacer is offline");
    expect(writes).toBe(0);
    await page.getByRole("button", { name: "Toggle connection" }).click();
    await page.getByRole("button", { name: "Probe bypass" }).click();
    await page.waitForFunction(() => document.body.dataset.probe === "sent");
    expect(writes).toBe(1);
  } finally { await page.close(); }
});

for (const state of ["policy-open", "policy-closed"] as const) for (const scheme of ["light", "dark"] as const) {
  browserTest(`wide Dispatch header keeps its controls on the title row with the ${state} caption at 1440 ${scheme}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    try {
      await page.goto(`${server.url}?state=${state}`);
      await page.locator(".pc-dispatch__policy").waitFor();
      const box = (selector: string) => page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
      const title = await box(".pc-dispatch__title"), controls = await box(".pc-dispatch__controls"), caption = await box(".pc-dispatch__policy");
      // One row, as at base: the controls start beside the title block, not on a line below it.
      expect(controls.top).toBeLessThan(title.bottom);
      expect(title.right).toBeLessThanOrEqual(controls.left);
      // The caption wraps inside the title column instead of pushing the controls down.
      expect(caption.right).toBeLessThanOrEqual(controls.left);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  });
}
