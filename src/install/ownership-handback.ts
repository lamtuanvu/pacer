import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Result } from "../commands/types";
import { serviceBackend, type ServiceDeps } from "../service";
import { runningWork, workCounts } from "../service/running-work";
import type { Ctx } from "../types";
import { pacerArgv } from "./self";
import { writeOwner } from "./owner";

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
    const target = readlinkSync(path);
    const resolved = isAbsolute(target) ? target : resolve(dirname(path), target);
    return /\.app\/Contents\//.test(resolved);
  } catch { return false; }
}

/** Newest `pacer.pre-app` or `pacer.pre-app-<stamp>` backup in `~/.local/bin`, by mtime. */
function newestPreAppBackup(binDir: string): string | null {
  let names: string[];
  try { names = readdirSync(binDir); } catch { return null; }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!/^pacer\.pre-app(-.*)?$/.test(name)) continue;
    const path = join(binDir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory()) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { path, mtimeMs: stat.mtimeMs };
    } catch { /* vanished mid-scan */ }
  }
  return best?.path ?? null;
}

/**
 * Atomic swap of `backup` into `link`'s place: hard-link the backup to a temp name (fails
 * if that exact temp name exists, which cannot collide in practice), then rename the temp
 * name over `link` (POSIX rename atomically replaces an existing destination, including a
 * symlink). Mirrors the non-macOS restore in desktop/src-tauri/src/link.rs
 * (`restore_takeover_backup`), which also hard-links then removes the original name.
 */
function restoreBackupOverLink(link: string, backup: string): void {
  const tmp = join(dirname(link), `.pacer-release-ownership-${randomUUID()}.tmp`);
  linkSync(backup, tmp);
  try { renameSync(tmp, link); } finally { rmSync(tmp, { force: true }); }
  unlinkSync(backup);
}

export interface ReleaseOwnershipDeps { force?: boolean; service?: ServiceDeps }

/**
 * `--release-ownership`: hands the installation back to this CLI. Restores the backed-up
 * terminal command if one exists and the link is still the desktop's, re-registers the
 * service from this CLI, and records owner "cli" unconditionally (this command IS the
 * explicit handback the ADR describes; unlike `claimCliOwnership` it does not defer to an
 * existing desktop record).
 */
export async function releaseOwnership(ctx: Ctx, deps: ReleaseOwnershipDeps = {}): Promise<Result> {
  try {
    const work = workCounts(await runningWork(ctx));
    if ((work.tasks || work.sessions) && !deps.force) {
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
      return { code: 2, out: "", err: `pacer: ${plural(work.tasks, "task")} and ${plural(work.sessions, "session")} are running. Rerun with --force to release ownership anyway.` };
    }
    const notes: string[] = [];
    const link = appLinkPath(ctx.home);
    const backup = newestPreAppBackup(join(ctx.home, ".local/bin"));
    if (backup && isDesktopLink(link)) {
      restoreBackupOverLink(link, backup);
      notes.push(`restored the terminal command from ${backup}`);
    } else if (backup) {
      notes.push(`found a backup at ${backup}, but ~/.local/bin/pacer is not the app's link; left it in place`);
    } else {
      notes.push("no pacer.pre-app backup found; left the terminal command as is");
    }
    const installNotes = await serviceBackend(ctx, deps.service).install({ replace: true });
    notes.push("re-registered the login service from this CLI", ...installNotes);
    const executable = pacerArgv(ctx.env)[0];
    writeOwner(ctx, { owner: "cli", executable, at: ctx.now });
    notes.push(`ownership released to this CLI (${executable})`);
    return { code: 0, out: notes.join("\n"), err: "" };
  } catch (e) { return { code: 1, out: "", err: `pacer: --release-ownership failed: ${message(e)}` }; }
}
