/**
 * Refuses dev/test/live-harness writes, copies, links, registrations or launches that would
 * land on the user's real pacer installation: `/Applications/pacer.app`, `~/.local/bin/pacer`
 * and `~/.local/bin/pacer-core`, the default `PACER_HOME` (`~/.pacer`), and the `com.pacer.serve`
 * LaunchAgent (its plist file and its gui launchd label). See
 * docs/decisions/0021-single-installation-owner.md ("Development and test builds never act as
 * an owner").
 *
 * Legitimate user-facing paths (install.sh, `pacer service install`, `pacer update`, the
 * desktop's consented takeover) never call this; it exists for scripts that build, stage,
 * launch or register things on behalf of development, tests or the live harness, where the
 * intended target is always a temporary PACER_HOME, a fixture bundle or a disposable app dir.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export interface RealInstallPaths {
  app: string;
  cli: string;
  core: string;
  pacerHome: string;
  servicePlist: string;
}
export function realInstallPaths(home: string = homedir()): RealInstallPaths {
  return {
    app: "/Applications/pacer.app",
    cli: join(home, ".local/bin/pacer"),
    core: join(home, ".local/bin/pacer-core"),
    pacerHome: join(home, ".pacer"),
    servicePlist: join(home, "Library/LaunchAgents/com.pacer.serve.plist"),
  };
}
/** The real service's gui launchd label (`LABEL` in src/service/index.ts); a fixture or live-harness label must never equal it. */
export const REAL_SERVICE_LABEL = "com.pacer.serve";

/**
 * realpath() the longest existing ancestor, so a symlink anywhere in the path cannot hide the
 * real target it resolves to, then rejoin any not-yet-created tail lexically (`..` included,
 * since `resolve()` already collapses it before this runs).
 */
function canonicalize(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break; // reached the filesystem root
    tail.unshift(relative(parent, current));
    current = parent;
  }
  try { current = realpathSync(current); } catch { /* lost a race with a deletion; keep the lexical form */ }
  return tail.length ? join(current, ...tail) : current;
}
function realInstallHit(path: string, home: string): string | undefined {
  const target = canonicalize(path);
  for (const real of Object.values(realInstallPaths(home))) {
    const canonicalReal = canonicalize(real);
    if (target === canonicalReal || target.startsWith(`${canonicalReal}/`)) return real;
  }
  return undefined;
}
const FIX = "use a temporary PACER_HOME / the fixture bundle dev.pacer.desktop.fixture / a temp app dir; "
  + "set PACER_ALLOW_REAL_INSTALL=1 only if you really mean to modify the user's install";

/** Throws unless `PACER_ALLOW_REAL_INSTALL=1`, naming the offending path and the fix. */
export function assertNotRealInstall(path: string, purpose: string, home: string = homedir()): void {
  if (process.env.PACER_ALLOW_REAL_INSTALL === "1") return;
  const hit = realInstallHit(path, home);
  if (hit) throw new Error(`refusing to ${purpose}: ${path} is the real pacer install path ${hit}; ${FIX}`);
}
/** Same refusal, for code that registers or controls a launchd job by label rather than by plist path. */
export function assertNotRealServiceLabel(label: string, purpose: string): void {
  if (process.env.PACER_ALLOW_REAL_INSTALL === "1") return;
  if (label === REAL_SERVICE_LABEL) throw new Error(`refusing to ${purpose}: ${label} is the real pacer service label; ${FIX}`);
}
