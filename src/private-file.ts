import { chmodSync, closeSync, existsSync, fchmodSync, futimesSync, linkSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Secure an existing directory as well as one created by this write. */
export function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Replace a state file without exposing a partially written value. */
export function privateWrite(path: string, value: string | Uint8Array, mode: 0o600 | 0o700 = 0o600): void {
  privateDir(dirname(path));
  const temporary = `${path}.pacer-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { flag: "wx", mode });
    chmodSync(temporary, mode);
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
    writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    linkSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Append without copying the existing log on every entry. */
export function privateAppend(path: string, value: string | Uint8Array): void {
  privateDir(dirname(path));
  const fd = openSync(path, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
  } finally { closeSync(fd); }
}

/** Advance an empty activity marker without rewriting it on every redraw. */
export function privateTouch(path: string): void {
  if (!existsSync(path)) privateWrite(path, "");
  const fd = openSync(path, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const now = new Date();
    futimesSync(fd, now, now);
  } finally { closeSync(fd); }
}
