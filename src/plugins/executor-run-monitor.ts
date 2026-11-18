import { progressPoller, rememberRetry, retryWatch } from "../exec/direct";
import { sessionLimitExcerpt, sessionLimitText } from "../exec/limits";
import { inputWaitStartedAt } from "../supervisor/active-time";
import { localRunIO, stopRun, type RunState } from "../supervisor/run";
import { readTask } from "../tasks/store";
import type { RunRef } from "../tasks/types";
import type { Ctx } from "../types";

export interface RunMonitor { stop(): Promise<void> }

/** The run a fresh attempt claimed, once the plugin has started it. */
function startedRun(ctx: Ctx, taskId: string, dir: string): RunRef | undefined {
  const t = readTask(ctx, taskId), run = t?.run;
  // The plugin starts its claimed run under the claim's task revision, so a task write before the start would refuse it.
  return run && run.dir === dir && !run.host && t.startIntent?.attempt === run.attempt && t.startIntent.dir === dir ? run : undefined;
}

/**
 * Watch an owned local run while the plugin's executor.run call is pending, as `supervise` does for the runs pacer
 * supervises itself: every `pollMs` the run's state goes to one progress poller, which writes the task's progress,
 * raises the idle and needs-input alerts, types pending messages into a live session and records conversation activity.
 * An idle, limit or provider verdict is persisted on the task's run before the run is stopped, so the outcome survives a
 * service restart; "asked" is left to the question flow. A fresh attempt passes its run directory and the monitor waits
 * for the plugin to start that run. A tick that fails is skipped; the monitor never breaks the plugin call.
 */
export function startRunMonitor(ctx: Ctx, taskId: string, run: RunRef | string,
  o: { pollMs?: number; poller?: typeof progressPoller } = {}): RunMonitor {
  const pollMs = o.pollMs ?? 2000, makePoller = o.poller ?? progressPoller;
  const dir = typeof run === "string" ? run : run.dir, io = localRunIO(dir), watch = retryWatch();
  let watched = typeof run === "string" ? undefined : run;
  let poll: ((s: RunState) => Promise<string>) | undefined;
  let stopped = false, wake: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  /** One poll; true once the run has exited or been stopped. */
  const tick = async (): Promise<boolean> => {
    watched ??= startedRun(ctx, taskId, dir);
    if (!watched) return false;
    const s = await io.read();
    if (s.exit !== null) return true;
    if (!s.alive) return false;
    poll ??= makePoller(ctx, readTask(ctx, taskId)!, watched, watch);
    const verdict = await poll(s);
    if (verdict !== "idle" && verdict !== "limit" && verdict !== "provider") return false;
    // A limit or retry loop never clears inside the session; idleness while the agent waits for input is not idle.
    if (verdict === "idle" && inputWaitStartedAt(s, Date.now()) !== null) return false;
    const t = readTask(ctx, taskId);
    if (stopped || !t || t.state !== "running" || t.stopPending || t.run?.dir !== dir || t.run.takeover ||
      t.run.interactionMode === "conversation" || s.report?.status === "done" || s.report?.status === "failed") return false;
    const now = Date.now() / 1000, prior = watched.retryBanner;
    const reason = verdict === "limit"
      ? watch.banner?.kind === "limit" ? watch.banner.reason : sessionLimitExcerpt(watched.executor, sessionLimitText(dir)) ?? "usage limit reached"
      : prior?.reason ?? (verdict === "provider" ? "unknown provider error" : "no output or file changes");
    rememberRetry(ctx, taskId, watched, {...prior, since: prior?.since ?? now, reason, ended: verdict});
    await stopRun(dir, {graceMs: 5000});
    return true;
  };
  const running = (async () => {
    while (!stopped) {
      try { if (await tick()) return; } catch { /* a failed tick is skipped; the next poll reads the run again */ }
      if (stopped) return;
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, pollMs); timer.unref?.(); });
    }
  })();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      wake?.();
      await running;
    },
  };
}
