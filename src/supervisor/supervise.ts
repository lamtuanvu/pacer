import type { RunState } from "./run";
import { type RunIO, Unreachable } from "./io";

export type SuperviseEnd = { kind: "reported" | "exited" | "timeout" | "stopped" | "idle" | "lost"; code: number };

export async function supervise(o: {
  io: RunIO; unreachableGraceMs?: number; deadlineMs: number; isStopped: () => boolean; pollMs?: number; graceMs?: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>; onPoll?: (s: RunState) => Promise<"continue" | "idle">;
}): Promise<SuperviseEnd> {
  const now = o.now ?? (() => Date.now()), sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms)), poll = o.pollMs ?? 2000;
  const stop = async (kind: SuperviseEnd["kind"]) => ({ kind, code: (await o.io.stop({ graceMs: o.graceMs ?? 5000, sleep })).code });
  let missing = 0, unreachableSince: number | null = null;
  for (;;) {
    let s: RunState;
    try {
      s = await o.io.read();
      unreachableSince = null;
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
      unreachableSince ??= now();
      if (now() - unreachableSince >= (o.unreachableGraceMs ?? 600_000)) return { kind: "lost", code: 137 };
      await sleep(poll);
      continue;
    }
    if (s.interactive && s.report && ["done", "failed"].includes(s.report.status)) {
      if (o.isStopped()) return stop("stopped");
      await o.io.stop({graceMs: o.graceMs ?? 5000, sleep});
      return {kind: "reported", code: s.report.status === "done" ? 0 : 1};
    }
    if (s.exit !== null) return { kind: "exited", code: s.interactive && s.exit === 0 ? 1 : s.exit };
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
