import { closeSync, fchmodSync, fstatSync, ftruncateSync, futimesSync, openSync, writeFileSync, writeSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve, sep } from "node:path";
import { NativeWriteError, writeNative, WRITE_CLOEXEC } from "./plugins/write-native";

function owned(stat: { uid: number }): boolean { return process.getuid === undefined || stat.uid === process.getuid(); }

// Darwin's root-owned /var and /tmp links point into /private. Canonicalize only
// these fixed system prefixes; every state-controlled component is opened no-follow.
function components(path: string): string[] {
  if (path.includes("\0")) throw new Error("Invalid state path");
  let absolute = resolve(path);
  if (process.platform === "darwin" && /^\/(var|tmp)(\/|$)/.test(absolute)) absolute = `/private${absolute}`;
  return absolute.split(sep).filter(Boolean);
}

function directoryFd(path: string): number {
  const native = writeNative();
  let fd = openSync(sep, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let enteredOwnedTree = false;
  try {
    const parts = components(path);
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      let next: number;
      try { next = native.openAt(fd, part, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | WRITE_CLOEXEC); }
      catch (error) {
        if (!(error instanceof NativeWriteError) || error.errno !== 2) throw error;
        try { native.mkdirAt(fd, part, 0o700); }
        catch (mkdirError) {
          if (!(mkdirError instanceof NativeWriteError) || mkdirError.errno !== 17) throw mkdirError;
        }
        next = native.openAt(fd, part, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | WRITE_CLOEXEC);
      }
      closeSync(fd);
      fd = next;
      const stat = fstatSync(fd);
      if (!stat.isDirectory() || (enteredOwnedTree && !owned(stat)) || (index === parts.length - 1 && !owned(stat)))
        throw new Error(`Refusing unowned state directory: ${path}`);
      if (owned(stat)) enteredOwnedTree = true;
      if (index === parts.length - 1 && (stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/** Secure an existing directory as well as one created by this write. */
export function privateDir(path: string): void { closeSync(directoryFd(path)); }

/** Open a private regular file without following any path component. */
export function privateOpen(path: string, truncate = false): number {
  const dir = directoryFd(dirname(path));
  try {
    const fd = writeNative().openAt(dir, basename(path), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | WRITE_CLOEXEC, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new Error(`Refusing non-private state file: ${path}`);
      if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
      if (truncate) ftruncateSync(fd, 0);
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  } finally { closeSync(dir); }
}

/** Replace a state file without exposing a partially written value. */
export function privateWrite(path: string, value: string | Uint8Array, mode: 0o600 | 0o700 = 0o600): void {
  const dir = directoryFd(dirname(path));
  const temporary = `${basename(path)}.pacer-${randomUUID()}.tmp`;
  const native = writeNative();
  try {
    const fd = native.openAt(dir, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | WRITE_CLOEXEC, mode);
    try { writeFileSync(fd, value); fchmodSync(fd, mode); }
    finally { closeSync(fd); }
    native.renameAt(dir, temporary, dir, basename(path));
  } finally {
    try {
      try { native.unlinkAt(dir, temporary, false); }
      catch (error) { if (!(error instanceof NativeWriteError) || error.errno !== 2) throw error; }
    } finally { closeSync(dir); }
  }
}

/** Publish a complete file only if the name is still absent. */
export function privateCreate(path: string, value: string | Uint8Array): void {
  const dir = directoryFd(dirname(path));
  const temporary = `${basename(path)}.pacer-${randomUUID()}.tmp`;
  const native = writeNative();
  try {
    const fd = native.openAt(dir, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | WRITE_CLOEXEC, 0o600);
    try { writeFileSync(fd, value); fchmodSync(fd, 0o600); }
    finally { closeSync(fd); }
    native.linkAt(dir, temporary, dir, basename(path));
  } finally {
    try {
      try { native.unlinkAt(dir, temporary, false); }
      catch (error) { if (!(error instanceof NativeWriteError) || error.errno !== 2) throw error; }
    } finally { closeSync(dir); }
  }
}

/** Append without copying the existing log on every entry. */
export function privateAppend(path: string, value: string | Uint8Array): void {
  const fd = privateOpen(path);
  try {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
  } finally { closeSync(fd); }
}

/** Advance an empty activity marker without rewriting it on every redraw. */
export function privateTouch(path: string): void {
  const fd = privateOpen(path);
  try {
    const now = new Date();
    futimesSync(fd, now, now);
  } finally { closeSync(fd); }
}
