export type Phase = "starting" | "working" | "idle" | "lost-contact";
export interface Progress { phase: Phase; lastOutputAt: number | null; lastChangeAt: number | null; files: number; commits: number; logBytes: number; host: string; updatedAt: number }

export function idleSeconds(p: Pick<Progress, "lastOutputAt" | "lastChangeAt">, startedAt: number, now: number): number {
  return now - Math.max(startedAt, p.lastOutputAt ?? 0, p.lastChangeAt ?? 0);
}

export function nextProgress(
  i: { now: number; startedAt: number; logBytes: number; lastOutputAt: number | null; files: number; commits: number; prev?: Progress; host?: string },
  idleAfterS: number,
): Progress {
  const changed = i.prev ? i.files !== i.prev.files || i.commits !== i.prev.commits : i.files > 0 || i.commits > 0;
  const lastChangeAt = changed ? i.now : i.prev?.lastChangeAt ?? null;
  const p = { lastOutputAt: i.lastOutputAt, lastChangeAt };
  const phase: Phase = i.logBytes === 0 && i.files === 0 && i.commits === 0 && i.now - i.startedAt < 60 ? "starting"
    : idleSeconds(p, i.startedAt, i.now) >= idleAfterS ? "idle" : "working";
  return { phase, ...p, files: i.files, commits: i.commits, logBytes: i.logBytes, host: i.host ?? "local", updatedAt: i.now };
}
