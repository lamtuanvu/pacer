import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  bundledOrcaPanelVersion,
  detectOrca,
  installOrcaPanel,
  oldOrcaPanelPresent,
  openOrcaPanel,
  resolveOrcaPanelDir,
  statusOrcaPanel,
  uninstallOrcaPanel,
  updateOrcaPanel,
} from "../plugin/orca-panel-cli";
import type { Ctx } from "../types";
import type { AppActionResult, AppAddResult, AppInfo, AppStatus } from "./types";

export const ORCA_APP: AppInfo = {
  id: "orca",
  name: "Orca",
  description:
    "Your pace, what needs you and what's running, for the worktree you're in, in Orca's sidebar, with the buttons to act on it.",
  additions: ["Sidebar panel", "Status bar item"],
  getUrl: "https://github.com/stablyai/orca",
};

function hostCaption(version?: string, running?: boolean): string | undefined {
  if (!version) return running ? "Orca is running" : undefined;
  return running === false ? `Orca ${version}` : `Orca ${version} is running`;
}

function panelAvailable(panelDir: string | null): panelDir is string {
  return Boolean(panelDir && existsSync(join(panelDir, "orca-plugin.json")));
}

/** Detect / status for the Orca card. Never touches other Orca plugins beyond reporting the old key. */
export async function orcaStatus(ctx: Ctx): Promise<AppStatus> {
  const panelDir = resolveOrcaPanelDir(ctx.env, ctx.env.PACER_BIN || process.execPath);
  const bundledVersion = bundledOrcaPanelVersion(panelDir) ?? undefined;
  const base = { ...ORCA_APP, panelDir: panelAvailable(panelDir) ? panelDir : null, oldPlugin: false };

  if (!panelAvailable(panelDir)) {
    return {
      ...base,
      presence: { kind: "missing_files", reason: "This pacer install doesn't include the Orca panel" },
      oldPlugin: false,
    };
  }

  const host = await detectOrca(ctx.run, ctx.which);
  if (!host.found) {
    return { ...base, presence: { kind: "not_found" }, oldPlugin: false };
  }

  const [panel, oldPlugin] = await Promise.all([statusOrcaPanel(ctx.run), oldOrcaPanelPresent(ctx.run)]);
  const hostVersion = hostCaption(host.version, host.running);

  if (!panel.installed) {
    return {
      ...base,
      oldPlugin,
      presence: { kind: "ready", ...(hostVersion ? { hostVersion } : {}), ...(host.running !== undefined ? { running: host.running } : {}) },
    };
  }

  const installedVersion = panel.version ?? "unknown";
  const updateAvailable = Boolean(bundledVersion && panel.version && bundledVersion !== panel.version);
  return {
    ...base,
    oldPlugin,
    presence: {
      kind: "added",
      ...(hostVersion ? { hostVersion } : {}),
      ...(host.running !== undefined ? { running: host.running } : {}),
      installedVersion,
      ...(bundledVersion ? { bundledVersion } : {}),
      updateAvailable,
    },
  };
}

export async function orcaAdd(ctx: Ctx, approve?: string): Promise<AppAddResult> {
  const panelDir = resolveOrcaPanelDir(ctx.env, ctx.env.PACER_BIN || process.execPath);
  const r = await installOrcaPanel(ctx.run, panelDir, approve);
  if (r.ok) return { status: "added", id: "orca" };
  if (r.needsApprove) {
    return {
      status: "approval_required",
      id: "orca",
      fingerprint: r.needsApprove,
      grants: r.grants ?? [],
      ...(r.stale ? { stale: true } : {}),
    };
  }
  return { status: "error", id: "orca", error: r.error };
}

export async function orcaUpdate(ctx: Ctx, approve?: string): Promise<AppAddResult> {
  const r = await updateOrcaPanel(ctx.run, approve);
  if (r.ok) return { status: "added", id: "orca" };
  if (r.needsApprove) {
    return {
      status: "approval_required",
      id: "orca",
      fingerprint: r.needsApprove,
      grants: r.grants ?? [],
      ...(r.stale ? { stale: true } : {}),
    };
  }
  return { status: "error", id: "orca", error: r.error };
}

export async function orcaOpen(ctx: Ctx): Promise<AppActionResult> {
  const r = await openOrcaPanel(ctx.run);
  return r.ok ? { ok: true, id: "orca" } : { ok: false, id: "orca", error: r.error };
}

export async function orcaRemove(ctx: Ctx): Promise<AppActionResult> {
  const r = await uninstallOrcaPanel(ctx.run);
  return r.ok ? { ok: true, id: "orca" } : { ok: false, id: "orca", error: r.error };
}
