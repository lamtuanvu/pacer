import { CoreError } from "../core/errors";

interface Job { start: () => void; cancel: (reason: CoreError) => void }
/** Bound transient concurrency without renewing queued requests' original clocks. */
export class CallAdmission {
  private active = 0;
  private readonly queued: Job[] = [];
  run<T>(deadlineAt: number, task: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    if (this.active >= 8 && this.queued.length >= 32) return Promise.reject(new CoreError("plugin_unavailable", "plugin registry call capacity exhausted"));
    if (Date.now() >= deadlineAt) return Promise.reject(new CoreError("plugin_timeout", "plugin call expired before admission"));
    if (parent?.aborted) return Promise.reject(new CoreError("plugin_unavailable", "owning plugin call ended"));
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let started = false, over = false, reason: CoreError | undefined;
      const finish = () => { over = true; clearTimeout(timer); parent?.removeEventListener("abort", abort); };
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
      const abort = () => job.cancel(new CoreError("plugin_unavailable", "owning plugin call ended"));
      const timer = deadlineAt === Infinity ? undefined : setTimeout(() => job.cancel(new CoreError("plugin_timeout", "plugin call passed its absolute deadline")), Math.max(0, deadlineAt - Date.now()));
      timer?.unref?.(); parent?.addEventListener("abort", abort, { once: true });
      if (this.active < 8) job.start(); else this.queued.push(job);
    });
  }
}
