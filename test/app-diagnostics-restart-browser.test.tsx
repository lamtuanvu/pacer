import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { join } from "node:path";
import { tmpDir } from "./helpers";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser, server: ReturnType<typeof Bun.serve>;
// restart: the service comes back with a new pid; stuck: the pid never changes, so the wait times out.
let mode: "restart" | "stuck" = "restart", calls: { op: string; params: any }[] = [], reads = 0, installs = 0, answered = 0;

const refresh = { kind: "auto", label: "Refresh usage", op: "limits.refresh", params: { account: "codex#tse" } };
const service = { kind: "auto", label: "Install pacer service", op: "service.install", consent: true };
// Two automatic fixes: the non-service one first, the service one restarted last.
const checks = (fixed: boolean) => [
  { name: "Usage codex#tse", level: fixed ? "ok" : "warn", detail: fixed ? "fresh" : "stale usage", remedy: refresh },
  { name: "Service", level: fixed ? "ok" : "fail", detail: fixed ? "installed: true; running: true; healthy: true" : "installed: true; running: false; healthy: false", remedy: service },
  { name: "Binary codex", level: "ok", detail: "installed" },
];
const report = (ok: boolean) => ({ checkedAt: 1, planner: "codex#work", repairAvailable: true, checks: checks(ok) });
const opCalls = (...ops: string[]) => calls.filter(c => ops.includes(c.op));
const opOrder = () => calls.map(c => c.op);

beforeAll(async () => {
  if (!browserPath) return;
  const out = tmpDir();
  const built = Bun.spawn([process.execPath, "build", "test/fixtures/diagnostics-restart-browser.tsx", "--target", "browser", "--outdir", out], { stdout: "pipe", stderr: "pipe" });
  if (await built.exited) throw Error(await new Response(built.stderr).text());
  const script = await Bun.file(join(out, "diagnostics-restart-browser.js")).text();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/ops/")) return new Response(`<!doctype html><html lang="en"><title>Diagnostics</title><meta charset="utf-8"><div id="root"></div><script type="module">${script}</script></html>`, { headers: { "Content-Type": "text/html" } });
    const op = path.slice(5), params = await req.json(); calls.push({ op, params });
    if (op === "doctor.run") { reads++; const body = report(mode === "restart" && reads > 1);
      // In the timed-out wait the message stays up only until the recheck answers; slow the recheck so it is observable.
      if (mode === "stuck" && reads > 1) await Bun.sleep(400); return Response.json(body); }
    if (op === "snapshot.get") {
      if (mode === "stuck" || installs === 0) return Response.json({ snapshot: { service: { pid: 10 } } });
      if (answered++ < 1) return Response.json({ snapshot: { service: { pid: 10 } } });
      return Response.json({ snapshot: { service: { pid: 11 } } });
    }
    if (op === "service.install") { installs++; return Response.json({ installed: true, running: true, restarting: true }); }
    if (op === "limits.refresh") return Response.json({});
    return Response.json({});
  } });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

function reset(next: "restart" | "stuck") { mode = next; calls = []; reads = 0; installs = 0; answered = 0; }
async function open(query = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(String(server.url) + query);
  await page.getByRole("button", { name: "Run all checks", exact: true }).click();
  await page.getByRole("heading", { name: /^Needs a fix/ }).waitFor();
  return page;
}

browserTest("fix-all runs the service install last and rechecks only after a new pid answers", async () => {
  reset("restart");
  const page = await open();
  try {
    await page.getByRole("button", { name: "Fix 2 issues automatically", exact: true }).click();
    const confirm = page.getByRole("group", { name: "Install pacer service" });
    await confirm.waitFor();
    await confirm.getByRole("button", { name: "Install pacer service", exact: true }).click();
    await page.getByText("Automatic fixes finished and checks refreshed. Review any remaining issues.", { exact: true }).waitFor();
    const order = opOrder();
    expect(order[0]).toBe("doctor.run");
    expect(opCalls("service.install")).toEqual([{ op: "service.install", params: { consent: true } }]);
    // The run: the other fix first, then the service fix; snapshot polls between; the recheck last.
    const install = order.indexOf("service.install"), recheckRead = order.lastIndexOf("doctor.run");
    const polls = order.filter((op, index) => op === "snapshot.get" && index > install);
    expect(polls).toHaveLength(2);
    expect(recheckRead).toBe(order.lastIndexOf("snapshot.get") + 1);
    expect(reads).toBe(2);
    // Both rows ended fixed; the service row showed the wait while the pid changed.
    await page.locator(".pc-diagnostic-row", { hasText: "Service" }).getByText("Fixed and rechecked just now.").waitFor();
    expect(installs).toBe(1);
  } finally { await page.close(); }
}, 15000);

browserTest("a single service fix shows the restart wait in its row and rechecks after the new pid", async () => {
  reset("restart");
  const page = await open();
  try {
    const row = page.locator(".pc-diagnostic-row", { hasText: "Service" });
    await page.getByRole("button", { name: /Install pacer service for Service/ }).click();
    await row.getByRole("group", { name: "Install pacer service" }).getByRole("button", { name: "Install pacer service", exact: true }).click();
    await row.getByText("Waiting for pacer to restart…").waitFor();
    await row.getByText("Fixed and rechecked just now.").waitFor();
    const order = opOrder();
    const install = order.indexOf("service.install"), recheckRead = order.lastIndexOf("doctor.run");
    const polls = order.filter((op, index) => op === "snapshot.get" && index > install);
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(recheckRead).toBe(order.lastIndexOf("snapshot.get") + 1);
    expect(reads).toBe(2);
  } finally { await page.close(); }
}, 15000);

browserTest("when the pid never changes the wait times out and the page says pacer has not come back", async () => {
  reset("stuck");
  const page = await open("?restartWaitMs=1200");
  try {
    const row = page.locator(".pc-diagnostic-row", { hasText: "Service" });
    await page.getByRole("button", { name: /Install pacer service for Service/ }).click();
    await row.getByRole("group", { name: "Install pacer service" }).getByRole("button", { name: "Install pacer service", exact: true }).click();
    // The recheck takes over the moment the wait ends, so its answer is slowed here to keep the message visible.
    await page.getByText(/pacer has not come back after a minute\. Checking anyway/).waitFor();
    // The recheck ran anyway after the wait, and the service row still fails.
    expect(reads).toBe(2);
    await row.getByText(/Still failing after the fix\./).waitFor();
  } finally { await page.close(); }
}, 15000);
