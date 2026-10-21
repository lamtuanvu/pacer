import { dashboardClient } from "../dashboard/client";
import type { ApiClient } from "../api/client-types";
import type { TaskDetail } from "../core/task-detail";
import type { Ctx } from "../types";
import type { Result } from "./types";

export const WATCH_USAGE = "watch <task-id> [--timeout <seconds>] [--json]   stream output until settled (default 600, max 3000)";
type LogPage = { stdout: string; stderr: string; next: { stdout: number; stderr: number }; done: boolean; source?: string };
type Options = { write?: (text: string) => void; pollMs?: number; signal?: AbortSignal };

/** Observe through the same read-only operations as other service clients. */
export async function watchCommand(args: string[], ctx: Ctx, options: Options = {}): Promise<Result> {
  let id: string | undefined, json = false, timeout = 600;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--timeout") {
      const value = args[++i];
      timeout = value === undefined ? NaN : Number(value);
    } else if (arg.startsWith("-") || id) return { code: 2, out: "", err: `usage: pacer ${WATCH_USAGE}` };
    else id = arg;
  }
  if (!id || !Number.isInteger(timeout) || timeout < 1 || timeout > 3000) {
    return { code: 2, out: "", err: `usage: pacer ${WATCH_USAGE}; timeout must be 1–3000 seconds` };
  }
  const taskId = id;
  const write = options.write ?? (text => { process.stdout.write(text); });
  const emit = (type: string, fields: Record<string, unknown>, text: string) => {
    write(json ? JSON.stringify({ type, task_id: taskId, ...fields }) + "\n" : text);
  };
  const controller = new AbortController();
  let timedOut = false, client: ApiClient | undefined;
  const interrupt = () => controller.abort();
  if (!options.signal) process.on("SIGINT", interrupt);
  options.signal?.addEventListener("abort", interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout * 1000);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("watch ended"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  async function observe(): Promise<Result> {
    client = await dashboardClient(ctx);
    if (controller.signal.aborted) { client.close(); throw new Error("watch ended"); }
    let state: string | undefined;
    let source: string | undefined;
    let offsets = { stdout: 0, stderr: 0 };
    while (!controller.signal.aborted) {
      const task = await client.call<TaskDetail>("task.get", { id: taskId });
      if (controller.signal.aborted) break;
      if (task.state !== state) {
        state = task.state;
        emit("state", { state }, `\n${taskId} ${state}\n`);
      }
      // Drain every bounded page, including output remaining when the task settles.
      let advanced: boolean;
      do {
        const page = await client.call<LogPage>("task.log", { id: taskId, ...offsets });
        if (controller.signal.aborted) break;
        if (page.source !== undefined && page.source !== source) {
          const changed = source !== undefined;
          source = page.source;
          if (changed) {
            offsets = { stdout: 0, stderr: 0 };
            advanced = true;
            continue; // Re-read the new source from zero; this page used old offsets.
          }
        }
        advanced = page.next.stdout > offsets.stdout || page.next.stderr > offsets.stderr;
        for (const stream of ["stdout", "stderr"] as const) {
          if (page[stream]) emit("output", { stream, ...(source === undefined ? {} : { source }), offset: offsets[stream], next: page.next[stream], text: page[stream] }, page[stream]);
        }
        offsets = page.next;
      } while (advanced && !controller.signal.aborted);
      if (controller.signal.aborted) break;
      if (task.state !== "queued" && task.state !== "running") {
        const reviewable = ["done", "partial"].includes(task.state) && !task.review && !task.resolved;
        const next = task.state === "needs_input" ? `pacer answer ${taskId} "<answer>"`
          : reviewable ? `pacer review ${taskId} --accept --json`
          : `pacer tasks ${taskId} --json`;
        emit("settled", { state: task.state, summary: task.summary, question: task.question ?? null, next },
          `\n${taskId} ${task.state}${task.summary ? `: ${task.summary}` : ""}\n${task.question ? task.question.text + "\n" : ""}Next: ${reviewable ? "Review the diff and run acceptance, then " : ""}${next}${reviewable ? " (or use --reject)" : ""}\n`);
        return { code: 0, out: "", err: "" };
      }
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(poll); controller.signal.removeEventListener("abort", wake); resolve(); };
        const poll = setTimeout(wake, options.pollMs ?? 500);
        controller.signal.addEventListener("abort", wake, { once: true });
      });
    }
    throw new Error("watch ended");
  }
  try {
    return await Promise.race([observe(), aborted]);
  } catch (error) {
    if (controller.signal.aborted) {
      emit(timedOut ? "timeout" : "interrupted", {}, `\n${taskId}: ${timedOut ? "watch timed out" : "stopped watching"}; task continues independently.\n`);
      return { code: timedOut ? 2 : 130, out: "", err: "" };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) emit("error", { message }, "");
    return { code: 2, out: "", err: `pacer: ${message}` };
  } finally {
    controller.abort();
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    options.signal?.removeEventListener("abort", interrupt);
    if (!options.signal) process.removeListener("SIGINT", interrupt);
    client?.close();
  }
}
