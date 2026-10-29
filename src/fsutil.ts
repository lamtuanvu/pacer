import { chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write JSON via a temp file + rename so readers never see a half-written file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/** mkdirSync's mode applies only to a directory it creates, so an existing, wider private directory is narrowed to
 * 0700 (SEC-7). One owned by another user is refused rather than written into. */
export function narrowDir(dir: string): void {
  const st = statSync(dir);
  if ((st.mode & 0o077) === 0) return;
  if (process.getuid && st.uid !== process.getuid()) {
    throw new Error(`${dir} is mode ${(st.mode & 0o777).toString(8)} and owned by another user; make it 0700 and owned by you`);
  }
  chmodSync(dir, 0o700);
}

/** Append one JSONL record to a 0600 file. Call it under the log's `wx` lock (the scoped SEC-7 append exception in
 * .project/decisions.md). If an interrupted earlier append left a partial last line, the record starts on a new line
 * so only the torn line is lost; readers skip it. */
export function appendJsonLine(path: string, record: string): void {
  const fd = openSync(path, "a+", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const size = fstatSync(fd).size, last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    const line = Buffer.from(`${torn ? "\n" : ""}${record}\n`);
    for (let written = 0; written < line.length;) written += writeSync(fd, line, written);
  } finally { closeSync(fd); }
}
