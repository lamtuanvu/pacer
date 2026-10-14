import { type RunState, readRun, stopRun } from "./run";

export type SuperviseEnd = { kind: "exited" | "timeout" | "stopped" | "idle" | "lost"; code: number };

export async function supervise(o: {
  dir: string; deadlineMs: number; isStopped: () => boolean; pollMs?: number; graceMs?: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>; onPoll?: (s: RunState) => Promise<"continue" | "idle">;
}): Promise<SuperviseEnd> {
  const now = o.now ?? (() => Date.now()), sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms)), poll = o.pollMs ?? 2000;
  const stop = async (kind: SuperviseEnd["kind"]) => ({ kind, code: (await stopRun(o.dir, { graceMs: o.graceMs ?? 5000, sleep })).code });
  let missing = 0;
  for (;;) {
    const s = readRun(o.dir);
    if (s.exit !== null) return { kind: "exited", code: s.exit };
    if (!s.alive) {
      // One extra poll covers the wrapper writing exit just after its process ended.
      if (++missing > 1) return { kind: "lost", code: 137 };
    } else missing = 0;
    if (o.isStopped()) return stop("stopped");
    if (now() >= o.deadlineMs) return stop("timeout");
    if (o.onPoll && (await o.onPoll(s)) === "idle") return stop("idle");
    await sleep(poll);
  }
}
