import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { grantsFromOrcaApproval, type AppGrant } from "../apps/grants";
import { parseOrcaOutput, sanitizedOrcaEnv } from "../exec/orca/client";
import type { RunFn, RunResult } from "../types";
import { isObj } from "../util";

/** Manifest `id` in plugins/orca-panel/orca-plugin.json. */
export const ORCA_PANEL_PLUGIN_ID = "pacer";

/** Orca plugin key for a folder install (`local.<id>`). Used for update/open/uninstall. */
export const ORCA_PANEL_PLUGIN_KEY = `local.${ORCA_PANEL_PLUGIN_ID}`;

/** Retired marketplace plugin key; reported so the person can remove it in Orca — pacer never removes it. */
export const ORCA_PANEL_OLD_PLUGIN_ID = "lamtuanvu.pacer";

function pluginKeyOf(row: Record<string, unknown>): string {
  if (typeof row.pluginKey === "string" && row.pluginKey) return row.pluginKey;
  if (typeof row.id === "string" && row.id) return row.id;
  return "";
}

function isOldPanel(key: string): boolean {
  return key === ORCA_PANEL_OLD_PLUGIN_ID || key.endsWith(`.${ORCA_PANEL_OLD_PLUGIN_ID}`);
}

function isOwnPanel(key: string): boolean {
  // Exact keys only — a third-party `acme.pacer` must never read as pacer's own panel.
  return key === ORCA_PANEL_PLUGIN_ID || key === ORCA_PANEL_PLUGIN_KEY;
}

/** Env override for tests and fixtures; never a user-facing install path. */
export const ORCA_PANEL_DIR_ENV = "PACER_ORCA_PANEL_DIR";

/** Long enough for the user to answer an in-Orca approval prompt, short enough to fail loudly. */
const PLUGIN_TIMEOUT_MS = 15_000;

/** The env `orca` sees: sanitized of Orca session attestations, and stripped of pacer's own context. */
function orcaPluginEnv(): Record<string, string | undefined> {
  const env = sanitizedOrcaEnv();
  for (const key of Object.keys(env)) if (key.startsWith("PACER_")) delete env[key];
  return env;
}

/** Packaged layouts relative to `execPath`: beside the CLI, or `../Resources` from MacOS/pacer. */
export function orcaPanelDirCandidates(execPath: string): string[] {
  const dir = dirname(execPath);
  return [join(dir, "orca-panel"), join(dir, "..", "Resources", "orca-panel")];
}

/**
 * Find the panel plugin folder: env override (tests), source checkout, then the packaged app
 * (`Contents/Resources/orca-panel` next to the bundled CLI, or beside `MacOS/pacer`).
 * Returns null when this install does not ship the panel files (npm/Homebrew today).
 * `exists` is injectable so packaged branches can be unit-tested without renaming the checkout.
 */
export function resolveOrcaPanelDir(
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const override = env[ORCA_PANEL_DIR_ENV]?.trim();
  if (override) return override;

  const source = fileURLToPath(new URL("../../plugins/orca-panel", import.meta.url));
  if (exists(join(source, "orca-plugin.json"))) return source;

  for (const candidate of orcaPanelDirCandidates(execPath)) {
    if (exists(join(candidate, "orca-plugin.json"))) return candidate;
  }

  return null;
}

/** Bundled panel version from orca-plugin.json, or null when the folder is missing. */
export function bundledOrcaPanelVersion(pluginDir: string | null = resolveOrcaPanelDir()): string | null {
  if (!pluginDir) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(pluginDir, "orca-plugin.json"), "utf8")) as { version?: string };
    return typeof manifest.version === "string" && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
}

interface OrcaOutcome {
  ok: boolean;
  error?: string;
  needsApprove?: string;
  grants?: AppGrant[];
  notInstalled?: boolean;
  stale?: boolean;
}

/** Map an orca error envelope to the outcome shape; `approval_required` / `approval_stale` keep fingerprint + grants. */
function orcaErrorOutcome(error: Record<string, unknown>): OrcaOutcome {
  const code = String(error.code ?? "");
  const message = String(error.message ?? "");
  if (code === "approval_required" || code === "approval_stale") {
    const data = isObj(error.data) ? error.data : error;
    const fingerprint = typeof data.approvalFingerprint === "string" ? data.approvalFingerprint : "";
    const grants = grantsFromOrcaApproval(data.grants);
    return {
      ok: false,
      error: message || `orca needs approval for the ${ORCA_PANEL_PLUGIN_ID} plugin (fingerprint ${fingerprint})`,
      needsApprove: fingerprint || undefined,
      grants: grants.length ? grants : undefined,
      stale: code === "approval_stale",
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

export type InstallOrcaPanelResult =
  | { ok: true }
  | { ok: false; error: string; needsApprove?: string; grants?: AppGrant[]; stale?: boolean };

/** `orca plugin install <pluginDir> [--approve <fp>] --json`; approval_required surfaces as `needsApprove` + grants. */
export async function installOrcaPanel(
  run: RunFn,
  pluginDir: string | null,
  approve?: string,
): Promise<InstallOrcaPanelResult> {
  if (!pluginDir || !existsSync(pluginDir)) {
    return {
      ok: false,
      error: pluginDir
        ? `the panel plugin's files are not available in this pacer install (expected ${pluginDir}); the desktop app ships them, npm and Homebrew installs do not yet`
        : "This pacer install doesn't include the Orca panel",
    };
  }
  const args = ["plugin", "install", pluginDir];
  if (approve) args.push("--approve", approve);
  const o = await orcaCall(run, args);
  if (o.ok) return { ok: true };
  return o.needsApprove !== undefined
    ? { ok: false, error: o.error!, needsApprove: o.needsApprove, grants: o.grants, stale: o.stale }
    : { ok: false, error: o.error! };
}

/** `orca plugin update <plugin-key> [--approve <fp>] --json`. */
export async function updateOrcaPanel(run: RunFn, approve?: string): Promise<InstallOrcaPanelResult> {
  const args = ["plugin", "update", ORCA_PANEL_PLUGIN_KEY];
  if (approve) args.push("--approve", approve);
  const o = await orcaCall(run, args);
  if (o.ok) return { ok: true };
  return o.needsApprove !== undefined
    ? { ok: false, error: o.error!, needsApprove: o.needsApprove, grants: o.grants, stale: o.stale }
    : { ok: false, error: o.error! };
}

interface PluginListRow { key: string; enabled?: boolean; version?: string }

/** Parse `orca plugin list --json` into rows (empty when unreadable). */
async function listOrcaPlugins(run: RunFn): Promise<PluginListRow[]> {
  const r = await run(["orca", "plugin", "list", "--json"], PLUGIN_TIMEOUT_MS, { env: orcaPluginEnv() });
  const parsed = parseOrcaOutput(r.stdout);
  const body = isObj(parsed) && parsed.ok === true && isObj(parsed.result) ? parsed.result : parsed;
  const rows = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.plugins) ? body.plugins : [];
  return rows.filter((p): p is Record<string, unknown> => isObj(p)).map((p) => {
    const key = pluginKeyOf(p);
    const out: PluginListRow = { key };
    if (typeof p.enabled === "boolean") out.enabled = p.enabled;
    else if (typeof p.status === "string") out.enabled = p.status === "enabled" || p.status === "running" || p.status === "idle";
    else if (typeof p.state === "string") out.enabled = p.state === "enabled";
    if (typeof p.version === "string" && p.version) out.version = p.version;
    return out;
  }).filter((p) => p.key);
}

/** `orca plugin list --json`; report only this plugin's row. An unreadable list reads as not installed. */
export async function statusOrcaPanel(run: RunFn): Promise<{ installed: boolean; enabled?: boolean; version?: string; key?: string }> {
  const rows = await listOrcaPlugins(run);
  const row = rows.find((p) => isOwnPanel(p.key));
  if (!row) return { installed: false };
  const out: { installed: boolean; enabled?: boolean; version?: string; key?: string } = { installed: true, key: row.key };
  if (typeof row.enabled === "boolean") out.enabled = row.enabled;
  if (typeof row.version === "string" && row.version) out.version = row.version;
  return out;
}

/** True when the retired marketplace plugin key is still listed in Orca. */
export async function oldOrcaPanelPresent(run: RunFn): Promise<boolean> {
  const rows = await listOrcaPlugins(run);
  return rows.some((p) => isOldPanel(p.key));
}

/** Detect whether the `orca` CLI is present and what version the app reports. */
export async function detectOrca(run: RunFn, which: (bin: string) => string | null): Promise<{
  found: boolean;
  running?: boolean;
  version?: string;
}> {
  if (!which("orca")) return { found: false };
  const r = await run(["orca", "status", "--json"], PLUGIN_TIMEOUT_MS, { env: orcaPluginEnv() });
  const parsed = parseOrcaOutput(r.stdout) ?? parseOrcaOutput(r.stderr);
  if (!isObj(parsed) || parsed.ok !== true || !isObj(parsed.result)) {
    // CLI exists but status failed — still "found" so the person can retry / open Orca.
    return { found: true };
  }
  const result = parsed.result as {
    app?: { running?: boolean };
    runtime?: { appVersion?: string; reachable?: boolean };
  };
  const version = typeof result.runtime?.appVersion === "string" ? result.runtime.appVersion : undefined;
  const running = result.app?.running === true || result.runtime?.reachable === true;
  return { found: true, ...(running !== undefined ? { running } : {}), ...(version ? { version } : {}) };
}

/** `orca plugin open <plugin-key> --panel pacer --json` — show the panel in Orca's sidebar. */
export async function openOrcaPanel(run: RunFn): Promise<{ ok: true } | { ok: false; error: string }> {
  const o = await orcaCall(run, ["plugin", "open", ORCA_PANEL_PLUGIN_KEY, "--panel", ORCA_PANEL_PLUGIN_ID]);
  return o.ok ? { ok: true } : { ok: false, error: o.error! };
}

/** `orca plugin uninstall <plugin-key> --json`; a "not installed" answer still counts as uninstalled. */
export async function uninstallOrcaPanel(run: RunFn): Promise<{ ok: true } | { ok: false; error: string }> {
  const o = await orcaCall(run, ["plugin", "uninstall", ORCA_PANEL_PLUGIN_KEY]);
  return o.ok || o.notInstalled ? { ok: true } : { ok: false, error: o.error! };
}
