import { existsSync, lstatSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "../commands/types";
import { serviceBackend, type ServiceDeps } from "../service";
import { runningWork, workCounts } from "../service/running-work";
import { DESKTOP_IDENTIFIERS } from "../update/desktop/bundle-identity";
import type { Ctx } from "../types";
import { writeInstallFile } from "./atomic";
import { isInsideAppBundle, readOwner, writeOwner } from "./owner";
import { pacerArgv } from "./self";

const message = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** `~/.local/bin/pacer`, matching `link_path` in desktop/src-tauri/src/link.rs. */
function appLinkPath(home: string): string {
  return join(home, ".local/bin/pacer");
}

/** True when `path` is a symlink, loosely into some `*.app/Contents/...` bundle: the desktop's link. */
function isDesktopLink(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return false;
    return isInsideAppBundle(path);
  } catch { return false; }
}

/**
 * Newest `pacer.pre-app` or `pacer.pre-app-<stamp>` backup in `~/.local/bin`, by the
 * timestamp embedded in the filename (desktop/src-tauri/src/link.rs writes it as
 * `YYYYMMDDTHHMMSSZ`, which sorts lexicographically in chronological order) — never by
 * filesystem mtime, which an unrelated touch, copy or backup tool can change. The bare,
 * un-timestamped `pacer.pre-app` (from the very first Welcome-consent takeover) sorts as
 * the oldest.
 */
function newestPreAppBackup(binDir: string): string | null {
  let names: string[];
  try { names = readdirSync(binDir); } catch { return null; }
  let best: { path: string; key: string } | null = null;
  for (const name of names) {
    const match = /^pacer\.pre-app(?:-(\d{8}T\d{6}Z))?$/.exec(name);
    if (!match) continue;
    const path = join(binDir, name);
    try { if (lstatSync(path).isDirectory()) continue; } catch { continue; }
    const key = match[1] ?? "";
    if (!best || key > best.key) best = { path, key };
  }
  return best?.path ?? null;
}

/** The real path this backup resolves to if it exists, the path itself otherwise. */
function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * What `link` will identify as once `backup` is renamed into its place, computed WITHOUT
 * mutating anything: a symlink backup keeps pointing at the same real target regardless of
 * which name holds it, so that target is stable before and after the rename. A regular-file
 * backup instead becomes the file living at `link` itself once renamed there (it is not a
 * symlink, so there is nothing further to resolve, and its old backup name will no longer
 * exist to resolve through).
 */
function identityAfterRestore(link: string, backup: string): string {
  try { if (lstatSync(backup).isSymbolicLink()) return realpathSync(backup); } catch { /* fall through */ }
  return link;
}

/**
 * Atomic: a plain `rename(2)` replaces `link`'s directory entry with `backup`'s, keeping
 * `backup`'s exact file type — including a symlink, which `fs.linkSync` (hard link) would
 * instead dereference. Matches the intent of the desktop's own `renamex_np` restore in
 * desktop/src-tauri/src/link.rs (`restore_takeover_backup`), without that call's exclusivity
 * (there, the destination name is empty by construction; here it is the live link we mean
 * to replace).
 */
function restoreBackupOverLink(link: string, backup: string): void {
  renameSync(backup, link);
}

interface HandbackPlan {
  /** The executable the service and the owner record must end up naming. Never inside a `.app` bundle. */
  executable: string;
  restore: { link: string; backup: string } | null;
  note: string;
}

/**
 * Decide what this handback would do, without touching the filesystem: whether a backup
 * would be restored over the desktop's link, and which executable the service/owner record
 * should name afterward. Fix for "the handback re-registers from the app bundle": the
 * result is never a path inside a `.app` bundle. With a restorable backup, its own
 * post-restore identity (see `identityAfterRestore`); otherwise the current link's real
 * target, or (rarely) this process's own resolved executable, as long as neither is inside
 * the app bundle; otherwise a refusal, because there would be nothing outside the bundle to
 * record.
 */
function planHandback(ctx: Ctx): HandbackPlan | { refusal: string } {
  const link = appLinkPath(ctx.home);
  const backup = newestPreAppBackup(join(ctx.home, ".local/bin"));
  if (backup && isDesktopLink(link)) {
    return { executable: identityAfterRestore(link, backup), restore: { link, backup }, note: `restored the terminal command from ${backup}` };
  }
  if (backup) {
    return { executable: realOrSelf(link), restore: null, note: `found a backup at ${backup}, but ~/.local/bin/pacer is not the app's link; left it in place` };
  }
  const candidates = [realOrSelf(link), pacerArgv(ctx.env)[0]];
  const outside = candidates.find(path => existsSync(path) && !isInsideAppBundle(path));
  if (outside) return { executable: outside, restore: null, note: "no pacer.pre-app backup found; left the terminal command as is" };
  return { refusal: "no pacer.pre-app backup exists, and the only pacer command found is inside the app bundle; there is nothing outside it to hand back to. Install a standalone CLI (install.sh, npm or Homebrew) first." };
}

/** $PACER_HOME has no fixed relation to the desktop's own per-OS app config directory. */
function desktopConfigDir(ctx: Pick<Ctx, "home" | "env">): string | null {
  if (process.platform === "darwin") return join(ctx.home, "Library/Application Support", DESKTOP_IDENTIFIERS.desktop);
  if (process.platform === "linux") return join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config"), DESKTOP_IDENTIFIERS.desktop);
  return null;
}

/**
 * Best effort: mirrors the desktop's own "Keep mine" bookkeeping (desktop/src-tauri/src/
 * client.rs `write_consent`/the `ShellAction::KeepMine` handler, and link.rs `remember`'s
 * `cli-choice.json`) so a desktop that is still running, or that relaunches, recognizes the
 * handback and stays attached quietly instead of re-offering "Use the app's pacer". Never
 * fails the handback itself: the owner record and the reinstalled service are the real
 * guarantee, this is only to avoid a stale prompt.
 */
async function recordKeepMine(ctx: Ctx, executable: string, notes: string[]): Promise<void> {
  const dir = desktopConfigDir(ctx);
  if (!dir) return;
  try {
    const at = new Date(Math.floor(ctx.now) * 1000).toISOString();
    // Matches ConsentRecord (desktop/src-tauri/src/ota/takeover/detect.rs): {at: String, path: bool, keep: bool}.
    writeInstallFile(join(dir, "consent.json"), JSON.stringify({ at, path: false, keep: true }), 0o600);
    const probe = await ctx.run([executable, "--version"], 5000);
    if (probe.code !== 0) return;
    const version = probe.stdout.trim();
    if (!version) return;
    // Matches KeepMine (desktop/src-tauri/src/link.rs): {path: String, version: String}.
    writeInstallFile(join(dir, "cli-choice.json"), JSON.stringify({ path: executable, version }), 0o600);
    notes.push("recorded Keep-mine so a running desktop app stays attached instead of re-offering its own CLI");
  } catch { /* best effort only; the handback itself already succeeded */ }
}

export interface ReleaseOwnershipDeps { force?: boolean; service?: ServiceDeps }

/**
 * `--release-ownership`: hands the installation back to this CLI. Ordered so a failed
 * service re-registration leaves the installation exactly as it was: nothing is mutated
 * until after that step succeeds (fix for "the handback is not transactional" — the backup
 * is consumed, and the owner record written, only once the service install has actually
 * succeeded; the owner record is written last of all). Refuses while tasks or terminal
 * sessions are running unless given `--force`.
 */
export async function releaseOwnership(ctx: Ctx, deps: ReleaseOwnershipDeps = {}): Promise<Result> {
  try {
    const work = workCounts(await runningWork(ctx));
    if ((work.tasks || work.sessions) && !deps.force) {
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
      return { code: 2, out: "", err: `pacer: ${plural(work.tasks, "task")} and ${plural(work.sessions, "session")} are running. Rerun with --force to release ownership anyway.` };
    }
    const previousOwner = readOwner(ctx);
    const plan = planHandback(ctx);
    if ("refusal" in plan) return { code: 2, out: "", err: `pacer: ${plan.refusal}` };
    const notes: string[] = [plan.note];
    // The risky step runs first, against nothing yet mutated: a thrown error here leaves
    // the backup untouched and the owner record unwritten.
    const installNotes = await serviceBackend(ctx, { ...deps.service, argv: [plan.executable] }).install({ replace: true });
    notes.push("re-registered the login service from this CLI", ...installNotes);
    if (plan.restore) restoreBackupOverLink(plan.restore.link, plan.restore.backup);
    writeOwner(ctx, { owner: "cli", executable: plan.executable, at: ctx.now });
    notes.push(`ownership released to this CLI (${plan.executable})`);
    if (previousOwner?.owner === "desktop") await recordKeepMine(ctx, plan.executable, notes);
    return { code: 0, out: notes.join("\n"), err: "" };
  } catch (e) { return { code: 1, out: "", err: `pacer: --release-ownership failed: ${message(e)}` }; }
}
