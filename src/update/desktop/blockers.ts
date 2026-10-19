import { z } from "zod";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../../types";
import type { Blocker } from "./types";
import { terminalClosureProof } from "./orca-proof";
import { OrcaClient } from "../../exec/orca/client";

function entries(path: string): string[] {
  try { return readdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function runFinished(dir: string): boolean {
  try {
    return /^\d+$/.test(readFileSync(join(dir, "exit"), "utf8").trim());
  } catch { return false; }
}

/** Raw persisted evidence only: taskStatus and sessionInfo have launch side effects. */
const storedTask = z.object({
  id: z.string(), state: z.enum(["queued", "running", "done", "partial", "failed", "limit", "stopped", "needs_input"]),
  brief: z.object({ goal: z.string(), repo: z.string() }), attempts: z.array(z.unknown()),
  title: z.string().optional(), queue: z.object({ reason: z.enum(["no_slot", "paused", "host_down", "waiting_retry"]), since: z.number().finite(), position: z.number().int().positive() }).optional(),
});
const storedJob = z.object({
  id: z.string(), kind: z.enum(["host.check", "runner.check", "host.repo.setup", "host.clean", "update.apply"]),
  state: z.enum(["running", "passed", "failed", "cancelled"]), pid: z.number().int().positive(),
  startedAt: z.number().finite(), steps: z.array(z.unknown()),
});
export function storedBlockers(ctx: Ctx): Blocker[] {
  const blockers: Blocker[] = [];
  for (const name of entries(join(ctx.pacerHome, "tasks")).filter(name => name.endsWith(".json"))) {
    const id = name.slice(0, -5);
    try {
      const task = storedTask.parse(JSON.parse(readFileSync(join(ctx.pacerHome, "tasks", name), "utf8")));
      if (task.id !== id) throw new Error("Task identity mismatch");
      if (task.state === "running" || (task.state === "queued" && !task.queue)) {
        blockers.push({ kind: "task", id, label: task.title ?? id });
      }
    } catch { blockers.push({ kind: "task", id, label: "Task state needs recovery" }); }
  }
  for (const task of entries(join(ctx.pacerHome, "runs"))) {
    const root = join(ctx.pacerHome, "runs", task);
    for (const attempt of entries(root)) {
      const dir = join(root, attempt);
      if (runFinished(dir)) continue;
      if (existsSync(join(dir, "pid")) || existsSync(join(dir, "session.json"))) {
        // A missing/denied PID query is not proof that the executor's descendants
        // finished. Keep unclosed runs until a completion receipt is available.
        blockers.push({ kind: "session", id: `${task}/${attempt}`, label: `Session ${task}` });
      }
    }
  }
  for (const name of entries(join(ctx.pacerHome, "state", "jobs")).filter(name => name.endsWith(".json"))) {
    const id = name.slice(0, -5);
    try {
      const job = storedJob.parse(JSON.parse(readFileSync(join(ctx.pacerHome, "state", "jobs", name), "utf8")));
      if (job.id !== id) throw new Error("Operation identity mismatch");
      if (job.state === "running") blockers.push({ kind: "operation", id, label: job.kind ?? id });
    } catch { blockers.push({ kind: "operation", id, label: "Operation state needs recovery" }); }
  }
  return blockers;
}

/** Terminal lifetime is independent of worker completion and viewer count. */
export async function externalBlockers(ctx: Ctx): Promise<Blocker[]> {
  const path = join(ctx.pacerHome, "orca.json");
  if (!existsSync(path)) return [];
  const orcaState = z.object({
    coordinator: z.string().nullable(), run: z.string().nullable(),
    workers: z.record(z.string(), z.object({
      dispatchId: z.string().min(1), taskId: z.string().min(1), executor: z.string().min(1),
      worktree: z.string().nullable(), terminal: z.string().nullable(), startedAt: z.number().finite(),
      incarnationId: z.string().optional(),
    })),
  });
  let workers: z.infer<typeof orcaState>["workers"];
  try { workers = orcaState.parse(JSON.parse(readFileSync(path, "utf8"))).workers; }
  catch { return [{ kind: "session", id: "orca", label: "Orca state needs recovery" }]; }
  const blockers: Blocker[] = [], client = new OrcaClient(ctx.run, ctx.env);
  for (const [id, worker] of Object.entries(workers)) {
    let ended = false;
    try {
      if (worker.terminal) {
        const reply = await client.terminalShow(worker.terminal);
        // A disconnected terminal can still own a live process. Only explicit
        // closed state proves the terminal has ended.
        ended = terminalClosureProof(reply, worker.terminal, worker.incarnationId);
      }
      // Without a bound terminal identity, a settled worker cannot certify
      // that its former terminal process stopped.
    } catch { /* An unavailable host remains a blocker. */ }
    if (!ended) blockers.push({ kind: "session", id: worker.taskId ?? id, label: "Orca session" });
  }
  return blockers;
}
