import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  installOrcaPanel,
  ORCA_PANEL_PLUGIN_ID,
  resolveOrcaPanelDir,
  statusOrcaPanel,
  uninstallOrcaPanel,
  updateOrcaPanel,
} from "../src/plugin/orca-panel-cli";
import type { RunFn, RunResult } from "../src/types";

const ok = (stdout = '{"ok":true,"result":{}}'): RunResult => ({ code: 0, stdout, stderr: "" });

interface Call { argv: string[]; timeoutMs: number; env?: Record<string, string | undefined> }

function recordingRun(reply: RunResult | ((argv: string[]) => RunResult) = ok(), calls: Call[] = []): RunFn {
  return async (argv, timeoutMs, options) => {
    calls.push({ argv, timeoutMs, env: options?.env });
    return typeof reply === "function" ? reply(argv) : reply;
  };
}

test("installOrcaPanel runs exactly `orca plugin install <pluginDir> --json` and nothing else", async () => {
  const calls: Call[] = [];
  const r = await installOrcaPanel(recordingRun(ok(), calls), "/path/to/plugins/orca-panel");
  expect(calls.map((c) => c.argv)).toEqual([["orca", "plugin", "install", "/path/to/plugins/orca-panel", "--json"]]);
  expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
  expect(calls[0]!.env).toBeDefined();
  expect(r).toEqual({ ok: true });
});

test("installOrcaPanel surfaces approval_required as needsApprove, not a crash", async () => {
  const run: RunFn = async () => ({ code: 3, stdout: "", stderr: '{"error":{"code":"approval_required","data":{"fingerprint":"ap1-x"}}}' });
  const r = await installOrcaPanel(run, "src");
  expect(r).toEqual({ ok: false, error: expect.any(String), needsApprove: "ap1-x" });
});

test("installOrcaPanel maps any other non-zero exit to { ok: false, error }", async () => {
  const run: RunFn = async () => ({ code: 1, stdout: "", stderr: "orca is not signed in" });
  const r = await installOrcaPanel(run, "src");
  expect(r).toEqual({ ok: false, error: "orca is not signed in" });
});

test("updateOrcaPanel runs `orca plugin update <id> --json`", async () => {
  const calls: Call[] = [];
  const r = await updateOrcaPanel(recordingRun(ok(), calls));
  expect(calls.map((c) => c.argv)).toEqual([["orca", "plugin", "update", ORCA_PANEL_PLUGIN_ID, "--json"]]);
  expect(r).toEqual({ ok: true });
});

test("updateOrcaPanel reports a failed update instead of crashing", async () => {
  const run: RunFn = async () => ({ code: 3, stdout: "", stderr: '{"error":{"code":"approval_required","data":{"fingerprint":"ap2-y"}}}' });
  const r = await updateOrcaPanel(run);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("ap2-y");
});

test("statusOrcaPanel runs `orca plugin list --json` and reports this plugin's row", async () => {
  const calls: Call[] = [];
  const stdout = '{"ok":true,"result":{"plugins":[{"id":"other"},{"id":"pacer","enabled":true,"version":"0.1.0"}]}}';
  const s = await statusOrcaPanel(recordingRun(ok(stdout), calls));
  expect(calls.map((c) => c.argv)).toEqual([["orca", "plugin", "list", "--json"]]);
  expect(s).toEqual({ installed: true, enabled: true, version: "0.1.0" });
});

test("statusOrcaPanel reports not installed when the list has no pacer row", async () => {
  const s = await statusOrcaPanel(recordingRun(ok('{"ok":true,"result":{"plugins":[{"id":"other"}]}}')));
  expect(s).toEqual({ installed: false });
});

test("uninstallOrcaPanel runs `orca plugin uninstall <id> --json` and tolerates 'not installed'", async () => {
  const calls: Call[] = [];
  const r = await uninstallOrcaPanel(recordingRun(ok(), calls));
  expect(calls.map((c) => c.argv)).toEqual([["orca", "plugin", "uninstall", ORCA_PANEL_PLUGIN_ID, "--json"]]);
  expect(r).toEqual({ ok: true });

  const notInstalled: RunFn = async () => ({ code: 1, stdout: "", stderr: "plugin not installed" });
  expect(await uninstallOrcaPanel(notInstalled)).toEqual({ ok: true });

  const coded: RunFn = async () => ({ code: 0, stdout: '{"ok":false,"error":{"code":"not_installed","message":"plugin not installed"}}', stderr: "" });
  expect(await uninstallOrcaPanel(coded)).toEqual({ ok: true });

  const failed: RunFn = async () => ({ code: 1, stdout: "", stderr: "orca is not running" });
  expect(await uninstallOrcaPanel(failed)).toEqual({ ok: false, error: "orca is not running" });
});

test("none of the four functions ever reference process.execPath or a pacer binary path in argv or env", async () => {
  const calls: Call[] = [];
  const stdout = '{"ok":true,"result":{"plugins":[{"id":"pacer","enabled":true,"version":"0.1.0"}]}}';
  const run = recordingRun(ok(stdout), calls);
  await installOrcaPanel(run, "plugins/orca-panel");
  await updateOrcaPanel(run);
  await statusOrcaPanel(run);
  await uninstallOrcaPanel(run);
  expect(calls).toHaveLength(4);
  for (const { argv, env } of calls) {
    for (const a of argv) {
      if (a === ORCA_PANEL_PLUGIN_ID) continue; // the plugin's own id is the one allowed "pacer"
      expect(a).not.toMatch(/pacer(\.|$)/i);
      expect(a).not.toBe(process.execPath);
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      expect(key.startsWith("PACER_")).toBe(false);
      expect(value ?? "").not.toMatch(/pacer(\.|$)/i);
    }
  }
});

test("resolveOrcaPanelDir returns an absolute path ending in plugins/orca-panel", () => {
  const dir = resolveOrcaPanelDir();
  expect(dir.endsWith(join("plugins", "orca-panel"))).toBe(true);
  expect(dir.startsWith("/")).toBe(true);
});

test("ORCA_PANEL_PLUGIN_ID matches plugins/orca-panel/orca-plugin.json's id", () => {
  const manifest = JSON.parse(readFileSync("plugins/orca-panel/orca-plugin.json", "utf8")) as { id: string };
  expect(ORCA_PANEL_PLUGIN_ID).toBe(manifest.id);
});
