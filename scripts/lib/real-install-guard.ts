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
import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

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

const MAX_SYMLINKS = 40;
const split = (absolutePath: string): string[] => absolutePath.split(sep).filter(Boolean);

/**
 * Resolve a path like realpath, but component by component with `lstat`/`readlink`, so a
 * symlink is followed even when its target does not exist (a dangling link). `existsSync`
 * (and therefore `fs.realpathSync`) is false for a dangling link, so a plain realpath-based
 * walk would treat the link itself as missing and never read where it points — letting a
 * dangling `out/x -> <real install path>` link through unresolved. Not-yet-created components
 * are kept lexically (`..` included, since `resolve()` already collapsed it on input).
 */
function canonicalize(path: string): string {
  let queue = split(resolve(path));
  let current: string = sep;
  let linkDepth = 0;
  let deadBranch = false;
  while (queue.length) {
    const next = join(current, queue.shift()!);
    if (deadBranch) { current = next; continue; }
    let stat;
    try { stat = lstatSync(next); } catch { deadBranch = true; current = next; continue; }
    if (stat.isSymbolicLink()) {
      if (++linkDepth > MAX_SYMLINKS) throw new Error(`too many levels of symbolic links: ${path}`);
      const link = readlinkSync(next);
      const resolved = isAbsolute(link) ? link : join(current, link);
      queue = [...split(resolved), ...queue];
      current = sep; // the resolved target is re-walked from the root, dangling or not
    } else current = next;
  }
  return current;
}
/**
 * Case-insensitive on darwin, where APFS is case-insensitive by default: an existing component
 * is already case-normalized by canonicalize()'s lstat walk, but a not-yet-created tail (e.g.
 * `/Applications/Pacer.app` before it's created) is still compared lexically, and the real
 * filesystem would treat it as the same entry as the real, differently-cased path regardless.
 */
function isUnderOrEqual(target: string, real: string): boolean {
  if (process.platform === "darwin") { target = target.toLowerCase(); real = real.toLowerCase(); }
  return target === real || target.startsWith(`${real}/`);
}
function realInstallHit(path: string, home: string): string | undefined {
  const target = canonicalize(path);
  for (const real of Object.values(realInstallPaths(home))) {
    if (isUnderOrEqual(target, canonicalize(real))) return real;
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
