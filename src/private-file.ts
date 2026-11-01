import { closeSync, fchmodSync, fstatSync, ftruncateSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, parse, resolve, sep } from "node:path";

function owned(stat: { uid: number }): boolean { return process.getuid === undefined || stat.uid === process.getuid(); }

function rejectOwnedSymlinks(path: string): void {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current += (current.endsWith(sep) ? "" : sep) + part;
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() && owned(stat)) throw new Error(`Refusing symlinked state directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Secure an existing directory as well as one created by this write. */
export function privateDir(path: string): void {
  rejectOwnedSymlinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || !owned(stat)) throw new Error(`Refusing unowned state directory: ${path}`);
    if ((stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

/** Open a private regular file without following a leaf symlink. */
export function privateOpen(path: string, truncate = false): number {
  privateDir(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !owned(stat)) throw new Error(`Refusing non-regular or unowned state file: ${path}`);
    if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    if (truncate) ftruncateSync(fd, 0);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/** Replace a state file without exposing a partially written value. */
export function privateWrite(path: string, value: string | Uint8Array, mode: 0o600 | 0o700 = 0o600): void {
  privateDir(dirname(path));
  const temporary = `${path}.pacer-${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try { writeFileSync(fd, value); fchmodSync(fd, mode); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Publish a complete file only if the name is still absent. */
export function privateCreate(path: string, value: string | Uint8Array): void {
  privateDir(dirname(path));
  const temporary = `${path}.pacer-${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, value); fchmodSync(fd, 0o600); }
    finally { closeSync(fd); }
    linkSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
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
