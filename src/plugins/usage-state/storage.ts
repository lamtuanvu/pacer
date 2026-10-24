import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, statfs } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CoreError } from "../../core/errors";

export const CHUNK = 262144;
const RESERVE = 8 * 1024 * 1024;
export function within(root: string, path: string) { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); }
export async function reserve(path: string, bytes: number) {
  const fs = await statfs(path); if (fs.bavail * fs.bsize < RESERVE + bytes) throw new CoreError("plugin_unavailable", "insufficient disk for usage state staging");
}
export async function privateDirectory(storePath: string, readOnly: boolean): Promise<string> {
  const parent = readOnly ? tmpdir() : dirname(storePath);
  if (!readOnly) { await mkdir(parent, { recursive: true, mode: 0o700 }); await chmod(parent, 0o700); }
  const dir = await mkdtemp(join(parent, ".pacer-usage-state-")); await chmod(dir, 0o700); return dir;
}
export async function writeParts(path: string, parts: AsyncIterable<string>, check: () => void) {
  const file = await open(path, "wx", 0o600);
  try { for await (const part of parts) {
    const bytes = Buffer.from(part);
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
  try { return await file.readFile("utf8"); } finally { await file.close(); }
}
