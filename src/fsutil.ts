import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write JSON via a temp file + rename so readers never see a half-written file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data));
    closeSync(fd);
    renameSync(tmp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    unlinkSync(tmp);
    throw error;
  }
}

/** Remove hour-old atomic-write temp files (`<file>.json.<pid|uuid>[.<uuid>].tmp`) that a killed writer left in the cache. */
export function sweepAtomicWriteTmps(pacerHome: string, now = Date.now()): number {
  const dir = join(pacerHome, "cache");
  let removed = 0, names: string[], before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(dir); if (!before.isDirectory()) return 0; names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!/\.json\.[0-9a-f-]+(\.[0-9a-f-]+)?\.tmp$/i.test(name)) continue;
    const path = join(dir, name);
    try {
      const current = lstatSync(dir);
      if (!current.isDirectory() || current.dev !== before.dev || current.ino !== before.ino) break;
      const entry = lstatSync(path);
      if (!entry.isFile() || now - entry.mtimeMs <= 60 * 60 * 1000) continue;
      unlinkSync(path); removed++;
    } catch { /* vanished; nothing to remove */ }
  }
  return removed;
}
