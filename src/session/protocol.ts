import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { compareVersions, currentVersion, isVersion } from "../update/version";
import type { ProcessIdentity } from "../update/desktop/process-identity";

/** The hello frame itself keeps v: 1 for older hosts. */
export const SESSION_PROTOCOL: readonly [number, number] = [1, 1];
export const SESSION_SUPPORT_MINORS = 3;
export const SESSION_VERSION_FILE = "session.version";

export interface SessionVersion { pacer: string; versions: [number, number]; identity?: ProcessIdentity }
export interface HostVersionView { pacer: string | null; older: boolean; supported: boolean }

const range = z.tuple([z.number().int().positive(), z.number().int().positive()]).refine(([min, max]) => min <= max);
const stored = z.object({
  pacer: z.string().min(1).max(64).refine(isVersion), versions: range,
  identity: z.object({ pid: z.number().int().positive(), bootId: z.string().min(1), birth: z.string().min(1) }).optional(),
});

export function parseVersions(value: unknown): [number, number] | null {
  const parsed = range.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Highest shared version. A client without a range speaks v1. */
export function negotiate(client: readonly [number, number] | null, host: readonly [number, number] = SESSION_PROTOCOL): number | null {
  const [min, max] = client ?? [1, 1];
  const top = Math.min(max, host[1]);
  return top >= Math.max(min, host[0]) ? top : null;
}

export function clientHello(): { versions: [number, number]; pacer: string } {
  return { versions: [SESSION_PROTOCOL[0], SESSION_PROTOCOL[1]], pacer: currentVersion() };
}

export function writeSessionVersion(dir: string, own: ProcessIdentity | null): void {
  const value: SessionVersion = { pacer: currentVersion(), versions: [SESSION_PROTOCOL[0], SESSION_PROTOCOL[1]], ...(own ? { identity: own } : {}) };
  const temp = join(dir, `.${SESSION_VERSION_FILE}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, join(dir, SESSION_VERSION_FILE));
  } finally { rmSync(temp, { force: true }); }
}

export function readSessionVersion(dir: string): SessionVersion | null {
  try {
    const parsed = stored.safeParse(JSON.parse(readFileSync(join(dir, SESSION_VERSION_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

const majorMinor = (version: string) => { const m = /^(\d+)\.(\d+)\./.exec(version); return m ? [Number(m[1]), Number(m[2])] as const : null; };

export function hostSupported(host: SessionVersion | null, current = currentVersion(), service: readonly [number, number] = SESSION_PROTOCOL): boolean {
  if (negotiate(host?.versions ?? null, service) === null) return false;
  if (!host) return true;
  const a = majorMinor(host.pacer), b = majorMinor(current);
  if (!a || !b) return true;
  return a[0] === b[0] ? b[1] - a[1] <= SESSION_SUPPORT_MINORS : a[0] > b[0];
}

export function hostOlder(host: SessionVersion | null, current = currentVersion()): boolean {
  if (!host) return true;
  try { return compareVersions(host.pacer, current) < 0; } catch { return true; }
}

/** Versions only, never paths: safe for public status. */
export function hostVersionView(dir: string, current = currentVersion()): HostVersionView {
  const host = readSessionVersion(dir);
  return { pacer: host?.pacer ?? null, older: hostOlder(host, current), supported: hostSupported(host, current) };
}
