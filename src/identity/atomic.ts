import { chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** SEC-7: temp file opened "wx" with 0600 in a 0700 directory, then renamed over the target. */
export function writePrivateFile(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { if (typeof data === "string") writeSync(fd, data); else writeSync(fd, data); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
