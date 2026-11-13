import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, statfs } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CoreError } from "../../core/errors";

export const CHUNK = 262144;
export const USAGE_STATE_MAX_BYTES = 16 * 1024 * 1024;
const RESERVE = 8 * 1024 * 1024;
export function within(root: string, path: string) { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); }
export async function reserve(path: string, bytes: number) {
  const fs = await statfs(path); if (fs.bavail * fs.bsize < RESERVE + bytes) throw new CoreError("plugin_unavailable", "insufficient disk for usage state staging");
}
export async function privateDirectory(storePath: string, readOnly: boolean): Promise<{ directory: string; identity: { device: number; inode: number } }> {
  const parent = readOnly ? tmpdir() : dirname(storePath);
  if (!readOnly) { await mkdir(parent, { recursive: true, mode: 0o700 }); await chmod(parent, 0o700); }
  const dir = await mkdtemp(join(parent, ".pacer-usage-state-"));
  try {
    await chmod(dir, 0o700);
    const info = await lstat(dir);
    return { directory: dir, identity: { device: info.dev, inode: info.ino } };
  }
  catch (error) { await rm(dir, { recursive: true, force: true }).catch(() => {}); throw error; }
}
export async function writeParts(path: string, parts: AsyncIterable<string>, check: () => void) {
  const file = await open(path, "wx", 0o600);
  let total = 0;
  try { for await (const part of parts) {
    const bytes = Buffer.from(part);
    total += bytes.length;
    if (total > USAGE_STATE_MAX_BYTES) throw new CoreError("too_large", "usage state exceeds 16 MiB limit");
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      check(); const chunk = bytes.subarray(offset, offset + CHUNK); await reserve(dirname(path), chunk.length); await file.writeFile(chunk);
    }
  } } finally { await file.close(); }
}
export async function* cursorParts(files: Record<string, unknown>, version: number, root?: string) {
  yield `{"version":${version},"files":{`; let first = true;
  for (const [path, value] of Object.entries(files)) {
    if (root && !within(root, path)) continue;
    yield `${first ? "" : ","}${JSON.stringify(path)}:`; yield JSON.stringify(value); first = false;
  }
  yield "}}";
}
export async function replaceCursor(path: string, files: Record<string, unknown>, version: number, check: () => void, validate: () => Promise<void>) {
  const parent = dirname(path); await mkdir(parent, { recursive: true, mode: 0o700 }); await chmod(parent, 0o700);
  const temp = join(parent, `.${randomUUID()}.tmp`);
  try { await writeParts(temp, cursorParts(files, version), check); await validate(); check(); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export async function allowedCursorPath(root: string, path: string) {
  if (!within(root, path) || !/(?:^|\/)rollout-[^/]*\.jsonl$/.test(path)) return false;
  const target = await lstat(path); if (!target.isFile() || target.isSymbolicLink()) return false;
  const resolvedRoot = await realpath(root), resolved = await realpath(path);
  return within(resolvedRoot, resolved) && resolved === join(resolvedRoot, relative(root, path));
}

/** The descriptor is host-fixed, but disk entries can still be symlinks. */
export async function guardStorePath(home: string, path: string) {
  if (!within(home, path)) throw new CoreError("capability_denied", "usage state path is outside host home");
  const pieces = relative(home, path).split("/");
  let current = home;
  for (const piece of pieces) {
    current = join(current, piece);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (current !== path && !info.isDirectory())) throw new CoreError("capability_denied", "usage state path contains a symlink or non-directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

export async function openStateFile(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new CoreError("capability_denied", "usage state is not a regular file");
  const { constants } = await import("node:fs");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino || !opened.isFile()) throw new CoreError("capability_denied", "usage state identity changed during open");
    return file;
  } catch (error) { await file.close(); throw error; }
}
export async function readStateFile(path: string) {
  const file = await openStateFile(path);
  try {
    if ((await file.stat()).size > USAGE_STATE_MAX_BYTES) throw new CoreError("too_large", "usage state exceeds 16 MiB limit");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

const SWEEP_AGE_MS = 60 * 60 * 1000, SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const lastSweep = new Map<string, number>();
/** Remove staging directories a killed process left behind. Leases end within their call deadline, so an hour-old one is orphaned. */
export async function sweepUsageState(pacerHome: string, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const parent of [join(pacerHome, "cache"), join(pacerHome, "state")]) {
    let names: string[], before: Awaited<ReturnType<typeof lstat>>;
    try { before = await lstat(parent); if (!before.isDirectory()) continue; names = await readdir(parent); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(".pacer-usage-state-")) continue;
      const path = join(parent, name);
      try {
        const current = await lstat(parent);
        if (!current.isDirectory() || current.dev !== before.dev || current.ino !== before.ino) break;
        const entry = await lstat(path);
        if (!entry.isDirectory() || now - entry.mtimeMs <= SWEEP_AGE_MS) continue;
        await rm(path, { recursive: true, force: true }); removed++;
      } catch { /* vanished or not removable; retry next sweep */ }
    }
  }
  return removed;
}
export async function sweepUsageStateIfDue(pacerHome: string, now = Date.now()): Promise<void> {
  if (now - (lastSweep.get(pacerHome) ?? -Infinity) < SWEEP_INTERVAL_MS) return;
  lastSweep.set(pacerHome, now);
  await sweepUsageState(pacerHome, now);
}
