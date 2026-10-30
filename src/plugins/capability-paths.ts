import { lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";

type Identity = { path: string; device: number; inode: number };
export interface PathSnapshot { path: string; canonical: string; stat: Stats; ancestors: Identity[] }
interface RootSnapshot { logical: string; canonical?: string; identity?: Identity }
const roots = new WeakMap<CallAuthority, Map<string, RootSnapshot>>();
const preparations = new WeakMap<CallAuthority, Promise<void>>();
/** Snapshot host-selected roots before a plugin can exercise the call. No lazy RPC pinning. */
export function prepareFilesystemAuthority(authority: CallAuthority): Promise<void> {
  authority.assertActive();
  const previous = preparations.get(authority);
  if (previous) return previous;
  const preparation = (async () => {
    const snapshots = new Map<string, RootSnapshot>();
    for (const resource of authority.resources.reads) {
      authority.assertActive();
      const path = absolutePath(resource.path), logical = resource.kind === "codex-logs" ? path : dirname(path);
      if (snapshots.has(logical)) continue;
      const snapshot: RootSnapshot = { logical };
      try {
        snapshot.canonical = await realpath(logical); authority.assertActive();
        const stat = await lstat(snapshot.canonical); authority.assertActive();
        if (!stat.isDirectory() || stat.isSymbolicLink()) return denied("read root is not a directory");
        snapshot.identity = identity(snapshot.canonical, stat);
        if (await realpath(logical) !== snapshot.canonical) return denied("read root changed during issuance");
        authority.assertActive();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A missing root stays missing for this call; never bind a newly-created replacement.
        snapshot.canonical = undefined; snapshot.identity = undefined;
      }
      snapshots.set(logical, snapshot);
    }
    authority.assertActive(); roots.set(authority, snapshots);
  })();
  preparations.set(authority, preparation);
  return preparation;
}
export const denied = (message = "path is outside the owning call's read scope"): never => { throw new CoreError("capability_denied", message); };
export const invalid = (message: string): never => { throw new CoreError("invalid_input", message); };
const contains = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
export function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || !isAbsolute(value)
    || value.split(/[\\/]/).some(part => part === "." || part === "..")) return denied();
  return resolve(value);
}
function scopePatterns(authority: CallAuthority, scopes: readonly string[]): string[] {
  const values: Record<string, string | null> = { HOME: authority.ctx.home, PACER_HOME: authority.ctx.pacerHome, ACCOUNT_HOME: authority.accountHome };
  return scopes.flatMap(scope => {
    let unavailable = false;
    const expanded = scope.replace(/\$\{([A-Z_]+)\}|\$([A-Z_]+)/g, (_match, braced, bare) => {
      const key = braced ?? bare;
      if (!Object.hasOwn(values, key)) return denied("unknown scope variable");
      const value = values[key];
      if (value === null) { unavailable = true; return ""; }
      if (!value || !isAbsolute(value)) return denied("scope variable is unavailable");
      return value;
    });
    if (unavailable) return [];
    if (!isAbsolute(expanded) || expanded.includes("$") || expanded.includes("\0")
      || expanded.split(/[\\/]/).some(part => part === "." || part === "..")) return denied("invalid declared read scope");
    return [expanded];
  });
}
export function declaredPath(authority: CallAuthority, scopes: readonly string[], path: string, directory = false): boolean {
  return scopePatterns(authority, scopes).some(pattern => new Bun.Glob(pattern).match(path)
    || (directory && pattern.startsWith(path + sep)));
}
function identity(path: string, stat: Stats): Identity { return { path, device: stat.dev, inode: stat.ino }; }
function same(a: Identity, stat: Stats) { return a.device === stat.dev && a.inode === stat.ino; }
/** Conservative identity checks, not a descriptor-rooted sandbox against same-user rewrites. */
export async function checkedPath(authority: CallAuthority, scopes: readonly string[], raw: unknown, directory = false): Promise<PathSnapshot | undefined> {
  authority.assertGranted("fs.read");
  const path = absolutePath(raw);
  const descriptor = authority.resources.reads.find(resource => resource.kind === "file" ? path === absolutePath(resource.path)
    : contains(absolutePath(resource.path), path) && ((directory && path === absolutePath(resource.path)) || /^rollout-.*\.jsonl$/.test(basename(path))));
  if (!descriptor || !declaredPath(authority, scopes, path, directory)) return denied();
  const snapshots = roots.get(authority) ?? denied("filesystem roots were not pinned at call issuance");
  const anchor = descriptor.kind === "codex-logs" ? absolutePath(descriptor.path) : dirname(absolutePath(descriptor.path));
  const root = snapshots.get(anchor) ?? denied("read root was not captured at call issuance");
  if (!root.canonical || !root.identity) { authority.assertActive(); return undefined; }
  const canonicalAnchor = root.canonical;
  let anchorStat: Stats;
  try {
    if (await realpath(anchor) !== canonicalAnchor) return denied("read root moved since call issuance");
    anchorStat = await lstat(canonicalAnchor);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    return denied("read root disappeared since call issuance");
  }
  if (!anchorStat.isDirectory() || anchorStat.isSymbolicLink() || !same(root.identity, anchorStat)) return denied("read root identity changed since call issuance");
  const canonical = resolve(canonicalAnchor, relative(anchor, path));
  if (!contains(canonicalAnchor, canonical)) return denied();
  const ancestors: Identity[] = [identity(canonicalAnchor, anchorStat)];
  let current = canonicalAnchor;
  for (const part of (canonical === canonicalAnchor ? "" : relative(canonicalAnchor, dirname(canonical))).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat: Stats;
    try { stat = await lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { authority.assertActive(); return undefined; } throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return denied("symlinked read ancestor refused");
    ancestors.push(identity(current, stat));
  }
  let stat: Stats;
  try { stat = await lstat(canonical); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { authority.assertActive(); return undefined; } throw error; }
  if (stat.isSymbolicLink() || (!stat.isFile() && !(directory && descriptor.kind === "codex-logs" && path === absolutePath(descriptor.path) && stat.isDirectory()))) return denied("read target must be a regular file or granted directory");
  if (await realpath(path) !== canonical) return denied("read path escaped its canonical root");
  const snapshot = { path, canonical, stat, ancestors };
  await revalidate(authority, snapshot);
  return snapshot;
}
export async function revalidate(authority: CallAuthority, snapshot: PathSnapshot): Promise<void> {
  authority.assertGranted("fs.read");
  for (const ancestor of snapshot.ancestors) {
    const stat = await lstat(ancestor.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(ancestor, stat)) return denied("read ancestor identity changed");
  }
  const current = await lstat(snapshot.canonical);
  if (current.isSymbolicLink() || !same(identity(snapshot.canonical, snapshot.stat), current)) return denied("read target identity changed");
  if (await realpath(snapshot.path) !== snapshot.canonical) return denied("read target moved outside its root");
  authority.assertActive();
}
