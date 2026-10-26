import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { join } from "node:path";
import { tmpDir } from "./helpers";

const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser, server: ReturnType<typeof Bun.serve>;
let calls: {op: string; params: any}[] = [];
let enabled = false, present = true, doctorFails = false, disableFails = false, removeFails = false, manifestVersion = 1;
const capabilities = () => manifestVersion === 1 ? [{ name: "config.get" }, { name: "fs.read", scopes: ["$HOME/project/**"] }] : [{name:"events.subscribe"}];
const row = () => ({ id: "fx-panel", version: `${manifestVersion}.0.0`, publisher: "Fixture", tier: "commercial", bundled: false,
  enabled, state: enabled ? "idle" : "needs_grant", contributes: ["surface"], capabilities: capabilities(),
  expectedConsent: String(manifestVersion).repeat(64),
  grant: enabled ? { version: `${manifestVersion}.0.0`, capabilities: capabilities().map(capability => capability.name) } : null,
  error: null, pid: null, surface: { prefix: "fx", available: enabled } });
function reset() { calls = []; enabled = false; present = true; doctorFails = false; disableFails = false; removeFails = false; manifestVersion = 1; }

beforeAll(async () => {
  if (!browserPath) return;
  const out = tmpDir();
  const built = Bun.spawn([process.execPath, "build", "test/fixtures/plugin-settings-browser.tsx", "--target", "browser", "--outdir", out], { stdout: "pipe", stderr: "pipe" });
  if (await built.exited) throw Error(await new Response(built.stderr).text());
  const script = await Bun.file(join(out, "plugin-settings-browser.js")).text();
  const styles = (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/styles.css"].map(path => Bun.file(path).text()))).join("\n");
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/app/plugins/fx/") return new Response("<h1>Fixture panel</h1>", { headers: { "Content-Type": "text/html" } });
    if (!path.startsWith("/ops/")) return new Response(`<div id="root"></div><style>${styles}</style><script type="module">${script}</script>`, { headers: { "Content-Type": "text/html" } });
    const op = path.slice(5), params = await req.json(); calls.push({ op, params });
    if (op === "plugin.list") return Response.json({ plugins: present ? [row()] : [] });
    if (op === "plugin.enable") { if (params.expectedConsent !== row().expectedConsent) return Response.json({code:"conflict",message:"Plugin permissions changed."},{status:409}); enabled = true; return Response.json({ id: "fx-panel", state: "idle" }); }
    if (op === "plugin.disable") { if (disableFails) return Response.json({ code: "internal", message: "Disable failed" }, { status: 500 }); enabled = false; return Response.json({ id: "fx-panel", state: "disabled" }); }
    if (op === "plugin.remove") { if (removeFails) return Response.json({ code: "internal", message: "Remove failed" }, { status: 500 }); present = false; return Response.json({ id: "fx-panel", removed: true }); }
    if (op === "plugin.doctor") { if (doctorFails) return Response.json({ code: "internal", message: "Check unavailable" }, { status: 500 }); return Response.json({ reports: [{ id: "fx-panel", ok: !enabled, state: enabled ? "idle" : "needs_grant", error: enabled ? null : "Needs permission" }] }); }
    return Response.json({ code: "unknown_op", message: op }, { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
}, 15_000);
afterAll(async () => { server?.stop(true); await browser?.close(); }, 15_000);

browserTest("grant requires explicit consent, uses plain copy and enables the panel", async () => {
  reset(); const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  try {
    await page.goto(String(server.url));
    await page.getByRole("button", { name: "Allow and enable" }).click();
    await page.getByRole("dialog", { name: "Allow plugin access" }).waitFor();
    expect(await page.getByRole("dialog").getByText("Read this plugin's pacer settings").count()).toBe(1);
    expect(await page.getByRole("dialog").getByText(/Read permitted files/).count()).toBe(1);
    expect(calls.filter(call => call.op === "plugin.enable")).toHaveLength(0);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect(calls.filter(call => call.op === "plugin.enable")).toHaveLength(0);
    await page.getByRole("button", { name: "Allow and enable" }).click();
    await page.getByRole("dialog").getByText("Technical capability IDs and scopes").click();
    expect(await page.getByRole("dialog").getByText("config.get", { exact: true }).count()).toBe(1);
    await page.getByRole("dialog").getByRole("button", { name: "Allow and enable" }).click();
    await page.getByRole("button", { name: "Open panel for fx-panel" }).waitFor();
    await page.getByRole("button", { name: "Open panel for fx-panel" }).click();
    const frame = page.getByTitle("fx-panel plugin panel");
    expect(await frame.evaluate(element => getComputedStyle(element).colorScheme)).toBe("light");
    expect(await frame.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
    expect(calls.filter(call => call.op === "plugin.enable")).toEqual([{ op: "plugin.enable", params: { id: "fx-panel", grant: true, expectedConsent: "1".repeat(64) } }]);
    const id = page.getByRole("article", { name: "Plugin fx-panel" }).locator("strong");
    expect(await id.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("nowrap");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await page.close(); }
}, 15_000);

browserTest("stale consent refreshes the dialog and requires a second review", async () => {
  reset(); const page = await browser.newPage();
  try {
    await page.goto(String(server.url));
    await page.getByRole("button", { name: "Allow and enable" }).click();
    await page.getByRole("dialog").getByText(/version 1.0.0/).waitFor();
    manifestVersion = 2;
    await page.getByRole("dialog").getByRole("button", { name: "Allow and enable" }).click();
    await page.getByRole("dialog").getByRole("alert").getByText(/permissions changed/).waitFor();
    await page.getByRole("dialog").getByText(/version 2.0.0/).waitFor();
    expect(await page.getByRole("dialog").getByText(/Follow task updates/).count()).toBe(1);
    expect(enabled).toBe(false);
    await page.getByRole("dialog").getByRole("button", { name: "Allow and enable" }).click();
    await page.getByRole("button", { name: "Open panel for fx-panel" }).waitFor();
    expect(calls.filter(call => call.op === "plugin.enable").map(call => call.params.expectedConsent)).toEqual(["1".repeat(64), "2".repeat(64)]);
  } finally { await page.close(); }
}, 15_000);

browserTest("doctor recovers from an error and disabling removes the open panel", async () => {
  reset(); enabled = true; doctorFails = true;
  const page = await browser.newPage();
  try {
    await page.goto(String(server.url));
    await page.getByRole("button", { name: "Run check" }).click();
    await page.getByRole("alert").getByText("Check unavailable").waitFor();
    doctorFails = false;
    await page.getByRole("button", { name: "Run check" }).click();
    await page.getByRole("status").getByText(/Check: Needs attention/).waitFor();
    await page.getByRole("button", { name: "Open panel for fx-panel" }).click();
    await page.getByTitle("fx-panel plugin panel").waitFor();
    disableFails = true;
    await page.getByRole("button", { name: "Disable" }).click();
    await page.getByRole("alert").getByText("Disable failed").waitFor();
    expect(await page.getByTitle("fx-panel plugin panel").count()).toBe(1);
    disableFails = false;
    await page.getByRole("button", { name: "Disable" }).click();
    await page.getByText("Panel unavailable while this plugin is disabled or needs attention.").waitFor();
    expect(calls.filter(call => call.op === "plugin.disable")).toEqual([{ op: "plugin.disable", params: { id: "fx-panel" } }, { op: "plugin.disable", params: { id: "fx-panel" } }]);
  } finally { await page.close(); }
}, 15_000);

browserTest("remove requires confirmation, reports failure and can retry", async () => {
  reset(); const page = await browser.newPage();
  try {
    await page.goto(String(server.url));
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog", { name: "Remove plugin" }).getByRole("button", { name: "Cancel" }).click();
    expect(calls.filter(call => call.op === "plugin.remove")).toHaveLength(0);
    removeFails = true;
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog", { name: "Remove plugin" }).getByRole("button", { name: "Remove plugin" }).click();
    await page.getByRole("alert").getByText("Remove failed").waitFor();
    removeFails = false;
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog", { name: "Remove plugin" }).getByRole("button", { name: "Remove plugin" }).click();
    await page.getByText("No plugins are installed.").waitFor();
    expect(calls.filter(call => call.op === "plugin.remove")).toHaveLength(2);
  } finally { await page.close(); }
}, 15_000);

browserTest("disconnected settings keep all mutations disabled", async () => {
  reset(); const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?disconnected=1`);
    await page.getByRole("button", { name: "Allow and enable" }).waitFor();
    for (const name of ["Allow and enable", "Run check", "Remove"]) expect(await page.getByRole("button", { name }).isDisabled()).toBe(true);
    expect(calls.filter(call => call.op !== "plugin.list")).toHaveLength(0);
  } finally { await page.close(); }
}, 15_000);
