import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

/** Atomic: mode 0600, temp file + rename, same pattern as other pacer state writes. */
export function writeOwner(ctx: Pick<Ctx, "pacerHome">, record: Omit<OwnerRecord, "schema">): void {
  const full: OwnerRecord = { schema: 1, ...record };
  writeInstallFile(ownerPath(ctx), JSON.stringify(full, null, 2) + "\n", 0o600);
}

/**
 * The CLI becomes the recorded owner only when installing the service (or running the
 * standalone installer's service step) succeeds, and only if nothing else already claimed
 * it: an absent record, or one that already says "cli". A desktop-owned record is never
 * overwritten here; that would silently take back an installation the user's own consent
 * handed to the app. Use `--release-ownership` for that.
 */
export function claimCliOwnership(ctx: Pick<Ctx, "pacerHome">, executable: string, at: number): void {
  const current = readOwner(ctx);
  if (current && current.owner !== "cli") return;
  writeOwner(ctx, { owner: "cli", executable, at });
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * Bundled-CLI exemption: the desktop must be able to run its own managed CLI (for example
 * `pacer open --print`, run from `Cli::run` in desktop/src-tauri/src/client.rs) without
 * tripping its own deference guard. We detect "this process is the desktop's own recorded
 * CLI" by resolved-executable identity rather than a one-off environment flag: `pacerArgv`
 * already resolves to `PACER_BIN` first when it is set, which is exactly the environment
 * variable the desktop sets when it spawns its managed CLI (see `Cli::run`'s
 * `command.env("PACER_BIN", binary)`), and otherwise resolves to this process's own argv/
 * execPath — i.e. the path of the binary that IS running. Comparing that resolved path
 * against the executable recorded in owner.json is therefore the same check whether the
 * desktop set PACER_BIN or the bundled CLI was simply exec'd directly: a foreign CLI cannot
 * forge this without also being the exact file the desktop recorded as its own.
 */
export function isRecordedOwnerExecutable(ctx: Ctx, owner: OwnerRecord): boolean {
  return canonical(pacerArgv(ctx.env)[0]) === canonical(owner.executable);
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
