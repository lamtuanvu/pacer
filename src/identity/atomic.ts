import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * SEC-7: temp file opened "wx" with 0600 in a 0700 directory, then renamed over the target. The file is fully written
 * and fsynced before the rename, and the directory after it, so a power loss leaves the old or the new content.
 */
export function writePrivateFile(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, path);
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } finally { rmSync(temp, { force: true }); }
}
