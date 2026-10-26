import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { relative } from "node:path";
import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";
import {
  absolutePath,
  checkedPath,
  denied,
  invalid,
  revalidate,
  type PathSnapshot,
} from "./capability-paths";

export { prepareFilesystemAuthority } from "./capability-paths";

const CHUNK = 256 * 1024;
export interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  inode: number;
  device: number;
  mode: number;
}
const info = (snapshot: PathSnapshot): FileInfo => ({
  path: snapshot.path,
  size: snapshot.stat.size,
  mtimeMs: snapshot.stat.mtimeMs,
  inode: snapshot.stat.ino,
  device: snapshot.stat.dev,
  mode: snapshot.stat.mode,
});
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    return invalid("invalid byte offset or length");
  return value;
}
function unchanged(stat: Stats, expected: Record<string, unknown>): boolean {
  return (
    expected.size === stat.size &&
    expected.mtimeMs === stat.mtimeMs &&
    expected.inode === stat.ino &&
    expected.device === stat.dev &&
    (expected.mode === undefined || expected.mode === stat.mode)
  );
}
async function read(
  authority: CallAuthority,
  snapshot: PathSnapshot,
  offset: number,
  length: number,
  expected?: Record<string, unknown>,
): Promise<{ bytes: Buffer; info: FileInfo }> {
  if (!snapshot.stat.isFile())
    return denied("only regular file bytes may be read");
  const file = await open(
    snapshot.canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await file.stat();
    if (
      !unchanged(before, {
        size: snapshot.stat.size,
        mtimeMs: snapshot.stat.mtimeMs,
        inode: snapshot.stat.ino,
        device: snapshot.stat.dev,
        mode: snapshot.stat.mode,
      }) ||
      !before.isFile() ||
      (expected && !unchanged(before, expected))
    )
      throw new CoreError(
        "conflict",
        "usage file identity or contents changed",
      );
    const bytes = Buffer.alloc(
      Math.min(length, Math.max(0, before.size - offset)),
    );
    let count = 0;
    while (count < bytes.length) {
      authority.assertActive();
      const result = await file.read(
        bytes,
        count,
        bytes.length - count,
        offset + count,
      );
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await file.stat();
    if (
      !unchanged(after, {
        size: before.size,
        mtimeMs: before.mtimeMs,
        inode: before.ino,
        device: before.dev,
        mode: before.mode,
      }) ||
      count !== bytes.length
    )
      throw new CoreError("conflict", "usage file changed during read");
    await revalidate(authority, snapshot);
    const current = await lstat(snapshot.canonical);
    if (
      !unchanged(current, {
        size: before.size,
        mtimeMs: before.mtimeMs,
        inode: before.ino,
        device: before.dev,
        mode: before.mode,
      })
    )
      throw new CoreError("conflict", "file observation changed during read");
    return {
      bytes: bytes.subarray(0, count),
      info: info({ ...snapshot, stat: after }),
    };
  } finally {
    await file.close();
  }
}
/** Filesystem effects are limited by both host-issued resources and declared scopes. */
const pending = new WeakSet<CallAuthority>();
export async function answerFilesystem(
  authority: CallAuthority,
  scopes: readonly string[],
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  authority.assertGranted("fs.read");
  if (pending.has(authority))
    return denied("owning call already has a filesystem operation");
  pending.add(authority);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let detach: (() => void) | undefined;
  try {
    detach = authority.onRevoke(() => settled);
    return await answer(authority, scopes, method, params);
  } finally {
    pending.delete(authority);
    settle();
    detach?.();
  }
}
async function answer(
  authority: CallAuthority,
  scopes: readonly string[],
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  authority.assertGranted("fs.read");
  if (method === "capability.fs.list") {
    const dir = absolutePath(params.dir),
      limit = params.limit === undefined ? 1000 : integer(params.limit, 1000);
    if (
      !limit ||
      typeof params.glob !== "string" ||
      !params.glob ||
      params.glob.length > 4096 ||
      params.glob.startsWith("/") ||
      params.glob.includes("\0") ||
      params.glob.split(/[\\/]/).some((part) => part === "." || part === "..")
    )
      return invalid("invalid read glob or list limit");
    const root = await checkedPath(authority, scopes, dir, true);
    if (!root) return { files: [], complete: true };
    if (!root.stat.isDirectory())
      return denied("list requires a granted directory");
    const files: FileInfo[] = [];
    let total = 0;
    for await (const match of new Bun.Glob(params.glob).scan({
      cwd: dir,
      absolute: true,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      authority.assertActive();
      if (relative(dir, match).startsWith("..")) return denied();
      let snapshot: PathSnapshot | undefined;
      try {
        snapshot = await checkedPath(authority, scopes, match);
      } catch (error) {
        if (error instanceof CoreError && error.code === "capability_denied")
          continue;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!snapshot) continue;
      total++;
      const entry = info(snapshot);
      const index = files.findIndex(
        (existing) => existing.mtimeMs < entry.mtimeMs,
      );
      if (index < 0) {
        if (files.length < limit) files.push(entry);
      } else {
        files.splice(index, 0, entry);
        if (files.length > limit) files.pop();
      }
    }
    await revalidate(authority, root);
    return { files, complete: total <= limit };
  }
  if (
    ![
      "capability.fs.read",
      "capability.fs.stat",
      "capability.fs.readRange",
    ].includes(method)
  )
    throw new CoreError("unknown_op", "unknown filesystem capability method");
  const snapshot = await checkedPath(
    authority,
    scopes,
    params.path,
    method === "capability.fs.stat",
  );
  if (!snapshot) return { missing: true };
  if (method === "capability.fs.stat")
    return {
      info: snapshot.stat.isFile()
        ? (await read(authority, snapshot, 0, 0)).info
        : info(snapshot),
    };
  if (method === "capability.fs.readRange") {
    const offset = integer(params.offset),
      length = integer(params.length, CHUNK);
    if (
      !params.expected ||
      typeof params.expected !== "object" ||
      Array.isArray(params.expected)
    )
      return invalid("expected file identity is required");
    const expected = params.expected as Record<string, unknown>;
    if (
      !["size", "inode", "device"].every(
        (key) =>
          typeof expected[key] === "number" &&
          Number.isSafeInteger(expected[key]) &&
          (expected[key] as number) >= 0,
      ) ||
      (expected.mode !== undefined &&
        (!Number.isSafeInteger(expected.mode) ||
          (expected.mode as number) < 0)) ||
      typeof expected.mtimeMs !== "number" ||
      !Number.isFinite(expected.mtimeMs)
    )
      return invalid("invalid expected file identity");
    const image = await read(authority, snapshot, offset, length, expected);
    return { base64: image.bytes.toString("base64"), info: image.info };
  }
  if (snapshot.stat.size > CHUNK)
    return { ranged: (await read(authority, snapshot, 0, 0)).info };
  const image = await read(authority, snapshot, 0, snapshot.stat.size);
  const value = {
    text: image.bytes.toString("utf8"),
    mtime: image.info.mtimeMs / 1000,
    mode: image.info.mode,
  };
  // Worst-case text escaping must still leave room for the bounded RPC envelope.
  return Buffer.byteLength(JSON.stringify(value)) > 768 * 1024
    ? { ranged: info(snapshot) }
    : value;
}
