import { createHash } from "node:crypto";

export type Phase = "driving" | "testing" | "needs-input" | "starting" | "working" | "idle" | "lost-contact";
export interface Progress { phase: Phase; lastOutputAt: number | null; lastChangeAt: number | null; files: number; commits: number; logBytes: number; host: string; updatedAt: number }

export function idleSeconds(p: Pick<Progress, "lastOutputAt" | "lastChangeAt">, startedAt: number, now: number): number {
  return now - Math.max(startedAt, p.lastOutputAt ?? 0, p.lastChangeAt ?? 0);
}

export function nextProgress(
  i: { now: number; startedAt: number; logBytes: number; lastOutputAt: number | null; files: number; commits: number; prev?: Progress; host?: string; changed?: boolean },
  idleAfterS: number,
): Progress {
  const changed = i.changed ?? (i.prev ? i.files !== i.prev.files || i.commits !== i.prev.commits : i.files > 0 || i.commits > 0);
  const lastChangeAt = changed ? i.now : i.prev?.lastChangeAt ?? null;
  const p = { lastOutputAt: i.lastOutputAt, lastChangeAt };
  const phase: Phase = i.logBytes === 0 && i.files === 0 && i.commits === 0 && i.now - i.startedAt < 60 ? "starting"
    : idleSeconds(p, i.startedAt, i.now) >= idleAfterS ? "idle" : "working";
  return { phase, ...p, files: i.files, commits: i.commits, logBytes: i.logBytes, host: i.host ?? "local", updatedAt: i.now };
}
/** Hash at most 4 MiB of git output, retaining the total byte length for larger diffs. */
export function gitFingerprint(status: string, diff: string): string {
  const hash = createHash("sha1");
  let remaining = 4 * 1024 * 1024, length = 0;
  for (const output of [status, diff]) {
    const bytes = Buffer.from(output);
    length += bytes.length;
    const take = Math.min(remaining, bytes.length);
    hash.update(bytes.subarray(0, take));
    remaining -= take;
  }
  return hash.update(`\0${length}`).digest("hex");
}
