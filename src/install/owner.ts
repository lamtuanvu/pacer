import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { isObj } from "../util";
import { readInstallFile, writeInstallFile } from "./atomic";
import { pacerArgv } from "./self";

export type Owner = "cli" | "desktop";
export interface OwnerRecord { schema: 1; owner: Owner; executable: string; at: number }

/** ADR 0021: one recorded owner for the whole installation, at $PACER_HOME/owner.json. */
export function ownerPath(ctx: Pick<Ctx, "pacerHome">): string {
  return join(ctx.pacerHome, "owner.json");
}

/** A missing or malformed record means "no recorded owner". Never throws. */
export function readOwner(ctx: Pick<Ctx, "pacerHome">): OwnerRecord | null {
  let text: string | null;
  try { text = readInstallFile(ownerPath(ctx)); } catch { return null; }
  if (text === null) return null;
  try {
    const data: unknown = JSON.parse(text);
    if (!isObj(data) || data.schema !== 1 || (data.owner !== "cli" && data.owner !== "desktop") ||
        typeof data.executable !== "string" || !isAbsolute(data.executable) ||
        typeof data.at !== "number" || !Number.isFinite(data.at)) return null;
    return { schema: 1, owner: data.owner, executable: data.executable, at: data.at };
  } catch { return null; }
}

/**
 * Atomic: mode 0600, temp file + rename, same pattern as other pacer state writes.
 * `at` is floored to whole unix seconds: the Rust reader declares it `u64`, and serde_json
 * refuses a JSON number with a decimal point there (a float silently makes the record
 * unreadable by the desktop, which must still interoperate with it).
 */
export function writeOwner(ctx: Pick<Ctx, "pacerHome">, record: Omit<OwnerRecord, "schema">): void {
  const full: OwnerRecord = { schema: 1, ...record, at: Math.floor(record.at) };
  writeInstallFile(ownerPath(ctx), JSON.stringify(full, null, 2) + "\n", 0o600);
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** True when `path` resolves into some `*.app/Contents/...` bundle. */
export function isInsideAppBundle(path: string): boolean {
  return /\.app\/Contents\//.test(canonical(path));
}

/**
 * The CLI becomes the recorded owner only when installing the service (or running the
 * standalone installer's service step) succeeds, and only if nothing else already claimed
 * it: an absent record, or one that already says "cli". A desktop-owned record is never
 * overwritten here; that would silently take back an installation the user's own consent
 * handed to the app. Use `--release-ownership` for that.
 *
 * Never claims an executable inside a `.app` bundle: that happens when the desktop's own
 * bundled CLI runs `service install` on its own behalf (its front door sets `PACER_BIN` to
 * its own canonical, in-bundle path), or when the user runs the command through the app's
 * `~/.local/bin/pacer` link. A "cli" record pointing into the app bundle is never correct;
 * the app is the real owner in that case, whatever the current record says.
 */
export function claimCliOwnership(ctx: Pick<Ctx, "pacerHome">, executable: string, at: number): void {
  if (isInsideAppBundle(executable)) return;
  const current = readOwner(ctx);
  if (current && current.owner !== "cli") return;
  writeOwner(ctx, { owner: "cli", executable, at });
}

/**
 * Bundled-CLI exemption: the desktop must run its own managed CLI (for example `pacer open
 * --print` from `Cli::run` in desktop/src-tauri/src/client.rs) without tripping its own
 * deference guard. A process qualifies when the CLI it resolves to (`PACER_BIN` first, which
 * the desktop sets for its managed CLI) is the recorded executable, or when it runs from the
 * recorded executable's own directory (the bundle's Resources, where the front door forwards
 * to `pacer-core`). This prevents accidental cross-owner changes; it is not an authorization
 * boundary, since anyone can set PACER_BIN.
 */
export function isRecordedOwnerExecutable(ctx: Ctx, owner: OwnerRecord): boolean {
  const recorded = canonical(owner.executable);
  return canonical(pacerArgv(ctx.env)[0]) === recorded || canonical(dirname(process.execPath)) === dirname(recorded);
}

export const MANAGED_BY_DESKTOP_MESSAGE =
  "pacer is managed by the pacer app; update or change the service from the app (Settings), or run with --release-ownership to hand it back to this CLI";

/**
 * Null when this command may proceed: no desktop owner is recorded, or this process IS the
 * desktop's own bundled CLI acting on its own behalf (see `isRecordedOwnerExecutable`).
 * Otherwise the exit-2 refusal the guarded commands return. Read-only commands never call this.
 */
export function ownerRefusal(ctx: Ctx, command: string): Result | null {
  const owner = readOwner(ctx);
  if (!owner || owner.owner !== "desktop" || isRecordedOwnerExecutable(ctx, owner)) return null;
  return { code: 2, out: "", err: `pacer ${command}: ${MANAGED_BY_DESKTOP_MESSAGE}` };
}
