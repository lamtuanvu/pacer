import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { join } from "node:path";
import { tmpDir } from "./helpers";
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser, server: ReturnType<typeof Bun.serve>, mode: "running" | "down" | "passed" = "running";
const job = (state: "running" | "passed") => ({ id: "update-1", kind: "update.apply", target: "pacer", state, startedAt: 1800000000, steps: [{ name: "Replace", state: "passed" }, { name: "Restart", state: state === "running" ? "running" : "passed", ...(state === "passed" ? { detail: "Updated to v0.15.1." } : {}) }] });
beforeAll(async () => {
  if (!browserPath) return;
  const out = tmpDir(); const build = await Bun.build({ entrypoints: ["test/fixtures/update-poll-browser.tsx"], outdir: out, target: "browser" }); if (!build.success) throw Error(String(build.logs));
  const script = await Bun.file(join(out, "update-poll-browser.js")).text();
  const css = (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/styles.css"].map(p => Bun.file(p).text()))).join("\n");
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/ops/")) return new Response(`<meta charset="utf-8"><div id="root"></div><style>${css}</style><script type="module">${script}</script>`, { headers: { "Content-Type": "text/html" } });
    const op = path.slice(5);
    if (op === "update.apply") return Response.json({ job: job("running") });
    // While the service restarts, the desktop transport answers this way.
    if (op === "job.get") return mode === "down" ? Response.json({ message: "Service is connecting" }, { status: 503 }) : Response.json(job(mode));
    return Response.json({});
  } });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { server?.stop(true); await browser?.close(); });
async function startUpdate() {
  mode = "running";
  const page = await browser.newPage();
  await page.goto(String(server.url));
  await page.getByRole("button", { name: "Install update" }).click();
  await page.locator(".u3-progress").getByText("Restart").waitFor();
  mode = "down";
  await page.getByText("Service is connecting").waitFor({ timeout: 5000 });
  return page;
}
browserTest("a poll that failed during the update's restart clears once pacer answers", async () => {
  const page = await startUpdate();
  try {
    mode = "passed";
    await page.getByText("Updated to v0.15.1.", { exact: false }).waitFor({ timeout: 5000 });
    await page.getByText("Service is connecting").waitFor({ state: "detached", timeout: 5000 });
  } finally { await page.close(); }
});
browserTest("a finished job event clears the failed poll's error without another poll", async () => {
  const page = await startUpdate();
  try {
    await page.evaluate(passed => (window as any).fixtureJobEvent(passed), job("passed"));
    await page.getByText("Service is connecting").waitFor({ state: "detached", timeout: 5000 });
    expect(await page.getByText("Updated to v0.15.1.", { exact: false }).count()).toBe(1);
  } finally { await page.close(); }
});
