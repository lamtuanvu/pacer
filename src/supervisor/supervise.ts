import type { RunState } from "./run";
import { type RunIO, Unreachable } from "./io";
import type { InteractionMode } from "../tasks/types";

export type SuperviseEnd = { kind: "reported" | "exited" | "timeout" | "stopped" | "idle" | "asked" | "lost"; code: number };

export async function supervise(o: {
  interactionMode?: InteractionMode;
  io: RunIO; unreachableGraceMs?: number; deadlineMs: number; isStopped: () => boolean; pollMs?: number; graceMs?: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>; onPoll?: (s: RunState) => Promise<"continue" | "idle" | "asked">;
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
    if (o.interactionMode !== "conversation" && s.interactive && s.report && ["done", "failed"].includes(s.report.status)) {
      if (o.isStopped()) return stop("stopped");
      await o.io.stop({graceMs: o.graceMs ?? 5000, sleep});
      return {kind: "reported", code: s.report.status === "done" ? 0 : 1};
    }
    if (s.exit !== null) return { kind: "exited", code: o.interactionMode !== "conversation" && s.interactive && s.exit === 0 ? 1 : s.exit };
    if (!s.alive) {
      // One extra poll covers the wrapper writing exit just after its process ended.
      if (++missing > 1) return { kind: "lost", code: 137 };
    } else missing = 0;
    if (o.isStopped()) return stop("stopped");
    if (o.interactionMode !== "conversation" && now() >= o.deadlineMs) return stop("timeout");
    // "asked": a delegated executor asked its parent and ended its turn; the run ends so the task can wait for the answer.
    const next = o.onPoll ? await o.onPoll(s) : "continue";
    if (next !== "continue" && o.interactionMode !== "conversation") return stop(next);
    await sleep(poll);
  }
}
