import { fileURLToPath } from "node:url";
import { parseOrcaOutput, sanitizedOrcaEnv } from "../exec/orca/client";
import type { RunFn, RunResult } from "../types";
import { isObj } from "../util";

/** The one Orca plugin pacer manages: its own bundled panel plugin (plugins/orca-panel/orca-plugin.json). */
export const ORCA_PANEL_PLUGIN_ID = "pacer";

/** Long enough for the user to answer an in-Orca approval prompt, short enough to fail loudly. */
const PLUGIN_TIMEOUT_MS = 15_000;

/** The bundled plugin folder pacer always installs — never a user-supplied path or URL (ADR 2026-11-19). */
export function resolveOrcaPanelDir(): string {
  return fileURLToPath(new URL("../../plugins/orca-panel", import.meta.url));
}

/** The env `orca` sees: sanitized of Orca session attestations, and stripped of pacer's own context. */
function orcaPluginEnv(): Record<string, string | undefined> {
  const env = sanitizedOrcaEnv();
  for (const key of Object.keys(env)) if (key.startsWith("PACER_")) delete env[key];
  return env;
}

interface OrcaOutcome { ok: boolean; error?: string; needsApprove?: string; notInstalled?: boolean }

/** Map an orca error envelope to the outcome shape; `approval_required` keeps its fingerprint. */
function orcaErrorOutcome(error: Record<string, unknown>): OrcaOutcome {
  const code = String(error.code ?? "");
  const message = String(error.message ?? "");
  if (code === "approval_required") {
    const data = isObj(error.data) ? error.data : {};
    const fingerprint = typeof data.approvalFingerprint === "string" ? data.approvalFingerprint : "";
    return {
      ok: false,
      error: message || `orca needs approval for the ${ORCA_PANEL_PLUGIN_ID} plugin (fingerprint ${fingerprint})`,
      needsApprove: fingerprint || undefined,
    };
  }
  if (code === "not_installed" || /not installed/i.test(message)) {
    return { ok: false, error: message || "not installed", notInstalled: true };
  }
  return { ok: false, error: message || code || "orca plugin call failed" };
}

/** Parse an `orca --json` plugin reply (envelope on stdout, or a bare error object on stderr). */
function orcaOutcome(r: RunResult): OrcaOutcome {
  const parsed = parseOrcaOutput(r.stdout) ?? parseOrcaOutput(r.stderr);
  if (isObj(parsed) && isObj(parsed.error) && parsed.ok !== true) return orcaErrorOutcome(parsed.error);
  if (r.code === 0) return { ok: true };
  const detail = (r.stderr.trim() || r.stdout.trim() || `orca exited with code ${r.code}`).slice(0, 500);
  if (/not installed/i.test(detail)) return { ok: false, error: detail, notInstalled: true };
  return { ok: false, error: detail };
}

async function orcaCall(run: RunFn, args: string[]): Promise<OrcaOutcome> {
  const r = await run(["orca", ...args, "--json"], PLUGIN_TIMEOUT_MS, { env: orcaPluginEnv() });
  return orcaOutcome(r);
}

/** `orca plugin install <pluginDir> --json`; approval_required surfaces as `needsApprove`. */
export async function installOrcaPanel(run: RunFn, pluginDir: string): Promise<{ ok: true } | { ok: false; error: string; needsApprove?: string }> {
  const o = await orcaCall(run, ["plugin", "install", pluginDir]);
  if (o.ok) return { ok: true };
  return o.needsApprove !== undefined
    ? { ok: false, error: o.error!, needsApprove: o.needsApprove }
    : { ok: false, error: o.error! };
}

/** `orca plugin update <id> --json`; approval_required folds its fingerprint into the error. */
export async function updateOrcaPanel(run: RunFn): Promise<{ ok: true } | { ok: false; error: string }> {
  const o = await orcaCall(run, ["plugin", "update", ORCA_PANEL_PLUGIN_ID]);
  return o.ok ? { ok: true } : { ok: false, error: o.error! };
}

/** `orca plugin list --json`; report only this plugin's row. An unreadable list reads as not installed. */
export async function statusOrcaPanel(run: RunFn): Promise<{ installed: boolean; enabled?: boolean; version?: string }> {
  const r = await run(["orca", "plugin", "list", "--json"], PLUGIN_TIMEOUT_MS, { env: orcaPluginEnv() });
  const parsed = parseOrcaOutput(r.stdout);
  const body = isObj(parsed) && parsed.ok === true && isObj(parsed.result) ? parsed.result : parsed;
  const rows = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.plugins) ? body.plugins : [];
  const row = rows.find((p): p is Record<string, unknown> => isObj(p) && p.id === ORCA_PANEL_PLUGIN_ID);
  if (!row) return { installed: false };
  const out: { installed: boolean; enabled?: boolean; version?: string } = { installed: true };
  if (typeof row.enabled === "boolean") out.enabled = row.enabled;
  else if (typeof row.state === "string") out.enabled = row.state === "enabled";
  if (typeof row.version === "string" && row.version) out.version = row.version;
  return out;
}

/** `orca plugin uninstall <id> --json`; a "not installed" answer still counts as uninstalled. */
export async function uninstallOrcaPanel(run: RunFn): Promise<{ ok: true } | { ok: false; error: string }> {
  const o = await orcaCall(run, ["plugin", "uninstall", ORCA_PANEL_PLUGIN_ID]);
  return o.ok || o.notInstalled ? { ok: true } : { ok: false, error: o.error! };
}
