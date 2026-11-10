import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { join } from "node:path";
import { tmpDir } from "./helpers";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser, server: ReturnType<typeof Bun.serve>;

// A deferred endpoint answer: the server holds until the test releases it after `waitFor` saw the text.
function hold() { let release!: () => void; const opened = new Promise<void>(resolve => release = resolve); return { opened, release }; }
// Fresh per test: the fixture pages share nothing after a test's page closes, including a hung hold.
let state: {
  mode: "restart" | "stuck";
  calls: { op: string; params: any }[];
  reads: number; installs: number; answered: number;
  pidChange: ReturnType<typeof hold>;
  recheckGate: ReturnType<typeof hold>;
};

const refresh = { kind: "auto", label: "Refresh usage", op: "limits.refresh", params: { account: "codex#tse" } };
const service = { kind: "auto", label: "Install pacer service", op: "service.install", consent: true };
// Two automatic fixes; the check list shows Service first, but the run must still install last.
const checks = (fixed: boolean) => [
  { name: "Service", level: fixed ? "ok" : "fail", detail: fixed ? "installed: true; running: true; healthy: true" : "installed: true; running: false; healthy: false", remedy: service },
  { name: "Usage codex#tse", level: fixed ? "ok" : "warn", detail: fixed ? "fresh" : "stale usage", remedy: refresh },
  { name: "Binary codex", level: "ok", detail: "installed" },
];
const report = (fixed: boolean) => ({ checkedAt: 1, planner: "codex#work", repairAvailable: true, checks: checks(fixed) });
const opCalls = (...ops: string[]) => state.calls.filter(c => ops.includes(c.op));
const opOrder = () => state.calls.map(c => c.op);

beforeAll(async () => {
  if (!browserPath) return;
  const out = tmpDir();
  const built = Bun.spawn([process.execPath, "build", "test/fixtures/diagnostics-restart-browser.tsx", "--target", "browser", "--outdir", out], { stdout: "pipe", stderr: "pipe" });
  if (await built.exited) throw Error(await new Response(built.stderr).text());
  const script = await Bun.file(join(out, "diagnostics-restart-browser.js")).text();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/ops/")) return new Response(`<!doctype html><html lang="en"><title>Diagnostics</title><meta charset="utf-8"><div id="root"></div><script type="module">${script}</script></html>`, { headers: { "Content-Type": "text/html" } });
    const op = path.slice(5), params = await req.json(); state.calls.push({ op, params });
    if (op === "doctor.run") { state.reads++; const body = report(state.mode === "restart" && state.reads > 1);
      // During a timed-out wait the message stays visible only until the recheck answers: the test releases this response after seeing it.
      if (state.mode === "stuck" && state.reads > 1) await state.recheckGate.opened; return Response.json(body); }
    if (op === "snapshot.get") {
      if (state.mode === "stuck" || state.installs === 0) return Response.json({ snapshot: { service: { pid: 10 } } });
      if (state.answered++ < 1) return Response.json({ snapshot: { service: { pid: 10 } } });
      // The new pid answers only after the test has seen the restart-wait text, so the row's states are deterministic.
      await state.pidChange.opened; return Response.json({ snapshot: { service: { pid: 11 } } });
    }
    if (op === "service.install") { state.installs++; return Response.json({ installed: true, running: true, restarting: true }); }
    if (op === "limits.refresh") return Response.json({});
    return Response.json({});
  } });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15000);
afterAll(async () => { await browser?.close(); server?.stop(true); });
beforeEach(() => {
  state = { mode: "restart", calls: [], reads: 0, installs: 0, answered: 0, pidChange: hold(), recheckGate: hold() };
});

async function open(query = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(String(server.url) + query);
  await page.getByRole("button", { name: "Run all checks", exact: true }).click();
  await page.getByRole("heading", { name: /^Needs a fix/ }).waitFor();
  return page;
}

browserTest("fix-all runs the service install last and rechecks only after a new pid answers", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Fix 2 issues automatically", exact: true }).click();
    const confirm = page.getByRole("group", { name: "Install pacer service" });
    await confirm.waitFor();
    await confirm.getByRole("button", { name: "Install pacer service", exact: true }).click();
    // The service row waits for the restarted service; installing order could break here only if untested.
    await page.locator(".pc-diagnostic-row", { hasText: "Service" }).getByText("Waiting for pacer to restart…").waitFor();
    expect(opOrder()).toContain("service.install");
    expect(opOrder().indexOf("limits.refresh")).toBeLessThan(opOrder().indexOf("service.install"));
    state.pidChange.release();
    await page.getByText("Automatic fixes finished and checks refreshed. Review any remaining issues.", { exact: true }).waitFor();
    const order = opOrder();
    expect(order[0]).toBe("doctor.run");
    expect(opCalls("service.install")).toEqual([{ op: "service.install", params: { consent: true } }]);
    // The run: the other fix first, then the service fix; snapshot polls between; the recheck last.
    const install = order.indexOf("service.install"), recheckRead = order.lastIndexOf("doctor.run");
    expect(order.indexOf("limits.refresh")).toBeLessThan(install);
    const polls = order.filter((op, index) => op === "snapshot.get" && index > install);
    expect(polls).toHaveLength(2);
    expect(recheckRead).toBe(order.lastIndexOf("snapshot.get") + 1);
    expect(state.reads).toBe(2);
    // Both rows ended fixed; the service row showed the wait while the pid changed.
    await page.locator(".pc-diagnostic-row", { hasText: "Service" }).getByText("Fixed and rechecked just now.").waitFor();
    expect(state.installs).toBe(1);
  } finally { await page.close(); }
}, 15000);

browserTest("a single service fix shows the restart wait in its row and rechecks after the new pid", async () => {
  const page = await open();
  try {
    const row = page.locator(".pc-diagnostic-row", { hasText: "Service" });
    await page.getByRole("button", { name: /Install pacer service for Service/ }).click();
    await row.getByRole("group", { name: "Install pacer service" }).getByRole("button", { name: "Install pacer service", exact: true }).click();
    await row.getByText("Waiting for pacer to restart…").waitFor();
    state.pidChange.release();
    await row.getByText("Fixed and rechecked just now.").waitFor();
    const order = opOrder();
    const install = order.indexOf("service.install"), recheckRead = order.lastIndexOf("doctor.run");
    const polls = order.filter((op, index) => op === "snapshot.get" && index > install);
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(recheckRead).toBe(order.lastIndexOf("snapshot.get") + 1);
    expect(state.reads).toBe(2);
  } finally { await page.close(); }
}, 15000);

browserTest("when the pid never changes the wait times out and the page says pacer has not come back", async () => {
  state.mode = "stuck";
  const page = await open("?restartWaitMs=1200");
  try {
    const row = page.locator(".pc-diagnostic-row", { hasText: "Service" });
    await page.getByRole("button", { name: /Install pacer service for Service/ }).click();
    await row.getByRole("group", { name: "Install pacer service" }).getByRole("button", { name: "Install pacer service", exact: true }).click();
    // The recheck takes over the moment the wait ends, so its answer waits in the hold until the page text was seen.
    await page.getByText(/pacer has not come back after a minute\. Checking anyway/).waitFor();
    state.recheckGate.release();
    // The recheck ran anyway after the wait, and the service row still fails.
    expect(state.reads).toBe(2);
    await row.getByText(/Still failing after the fix\./).waitFor();
  } finally { await page.close(); }
}, 15000);
