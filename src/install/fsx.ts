import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** now is Unix seconds; backup names use the local wall-clock time. */
export function backupPath(path: string, now: number): string {
  const date = new Date(now * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const base = `${path}.pacer-bak-${day}-${time}`;
  let candidate = base;
  for (let suffix = 2; existsSync(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}

export function shq(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export function shellCommand(argv: string[]): string {
  return argv.map(shq).join(" ");
}
