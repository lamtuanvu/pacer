import { scheduleDeadline } from "../deadline";
import { CoreError } from "../core/errors";

interface Job { start: () => void; cancel: (reason: CoreError) => void }
/** Bound transient concurrency without renewing queued requests' original clocks. */
export class CallAdmission {
  private active = 0;
  private readonly queued: Job[] = [];
  run<T>(deadlineAt: number, task: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    const parentFailure = () => parent?.reason instanceof CoreError && parent.reason.code === "plugin_timeout"
      ? parent.reason : new CoreError("plugin_unavailable", "owning plugin call ended");
    if (this.active >= 8 && this.queued.length >= 32) return Promise.reject(new CoreError("plugin_unavailable", "plugin registry call capacity exhausted"));
    if (Date.now() >= deadlineAt) return Promise.reject(new CoreError("plugin_timeout", "plugin call expired before admission"));
    if (parent?.aborted) return Promise.reject(parentFailure());
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let started = false, over = false, reason: CoreError | undefined;
      const finish = () => { over = true; cancelDeadline(); parent?.removeEventListener("abort", abort); };
      const job: Job = {
        cancel: failure => {
          if (over || reason) return;
          reason = failure; controller.abort();
          if (!started) {
            const index = this.queued.indexOf(job); if (index >= 0) this.queued.splice(index, 1);
            finish(); reject(failure);
          }
        },
        start: () => {
          if (over) return;
          if (Date.now() >= deadlineAt) { job.cancel(new CoreError("plugin_timeout", "plugin call expired before execution")); return; }
          started = true; this.active++;
          void Promise.resolve().then(() => {
            if (controller.signal.aborted) throw reason;
            return task(controller.signal);
          }).then(
            value => {
              if (!reason && Date.now() >= deadlineAt) reason = new CoreError("plugin_timeout", "plugin call completed after its absolute deadline");
              finish(); if (reason) reject(reason); else resolve(value);
            },
            failure => { finish(); reject(reason ?? failure); },
          ).finally(() => { this.active--; this.queued.shift()?.start(); });
        },
      };
      const abort = () => job.cancel(parentFailure());
      const cancelDeadline = scheduleDeadline(deadlineAt, () => job.cancel(new CoreError("plugin_timeout", "plugin call passed its absolute deadline")), true); parent?.addEventListener("abort", abort, { once: true });
      if (this.active < 8) job.start(); else this.queued.push(job);
    });
  }
}

/** A canceled waiter is removed immediately; only running work owns cleanup. */
export class SerialCalls {
  private active = false;
  private readonly queued: { start(): void; cancel(): void }[] = [];
  run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const detach = () => signal.removeEventListener("abort", job.cancel);
      const job = {
        cancel: () => {
          if (started) return; // The running action owns its cancellation/cleanup.
          const index = this.queued.indexOf(job);
          if (index >= 0) this.queued.splice(index, 1);
          detach(); reject(new CoreError("plugin_unavailable", "owning plugin call ended before execution"));
        },
        start: () => {
          if (signal.aborted) { job.cancel(); this.next(); return; }
          started = true; detach(); this.active = true;
          void Promise.resolve().then(action).then(resolve, reject).finally(() => this.next());
        },
      };
      signal.addEventListener("abort", job.cancel, { once: true });
      if (signal.aborted) job.cancel();
      else if (this.active) this.queued.push(job);
      else job.start();
    });
  }
  private next(): void { this.active = false; this.queued.shift()?.start(); }
}
