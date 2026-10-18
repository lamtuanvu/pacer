import { repoFs, withTimeout } from "../core/path-probe";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import type { TaskRecord } from "../tasks/types";
import { readTask, updateTask } from "../tasks/store";
import { loadStrategy } from "../config/strategy";
import { parseRunnerId } from "../config/runner-id";
import { providerEnv } from "../exec/launch";
import { execProcess, executorEnv } from "../exec/process";
import { stopRun } from "../supervisor/run";
import { CoreError } from "../core/errors";
import { validateTaskId } from "./targets";

export const missingSession = (executor: string) => `Take over needs the agent's session id; \`${executor}\` does not report one. Stop the task and retry it interactively instead.`;
/** Cheap checks only: OpenCode discovery is deferred until the user requests takeover. */
export function takeoverAvailability(task: TaskRecord): {available: boolean; reason?: string} {
  const run = task.run, agent = parseRunnerId(run?.executor ?? task.executor ?? "")?.agent ?? run?.executor;
  const reason = task.state !== "running" ? "Take over requires a running task."
    : run?.host || parseRunnerId(run?.executor ?? "")?.host ? "Take over is not supported for remote runs."
    : (task.backend && task.backend !== "direct") || task.result?.backend === "orca" ? "Take over requires the direct backend."
    : !run ? "Take over requires an active run."
    : run.takeover || task.takeover?.state === "starting" || existsSync(join(run.dir, "interactive.json")) ? "This task is already interactive or being taken over."
    : agent === "agy" || !["codex", "claude-code", "cursor", "opencode"].includes(agent ?? "") ? missingSession(run.executor)
    : !run.agentSession && agent !== "opencode" ? missingSession(run.executor) : undefined;
  return reason ? {available: false, reason} : {available: true};
}
/** Different OpenCode versions return either the list or an object wrapping it. */
export function parseOpencodeSessions(text: string, taskId: string): string | undefined {
  try {
    const rows: Record<string, any>[] = [];
    const visit = (value: unknown, depth = 0) => {
      if (depth > 6 || !value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
      const row = value as Record<string, any>;
      if (typeof row.id === "string" && row.id.trim() && row.title === `pacer ${taskId}`) rows.push(row);
      else for (const key of ["sessions", "data", "items", "result"]) visit(row[key], depth + 1);
    };
    visit(JSON.parse(text));
    const timestamp = (r: Record<string, any>) => {
      const v = r.time?.updated ?? r.time?.created ?? r.updatedAt ?? r.updated ?? r.createdAt ?? r.created;
      return typeof v === "number" ? v : typeof v === "string" ? Number(v) || Date.parse(v) || 0 : 0;
    };
    return rows.sort((a,b) => timestamp(b) - timestamp(a))[0]?.id;
  } catch { return undefined; }
}
export async function takeoverTask(ctx: Ctx, id: string, by?: string) {
  validateTaskId(id);
  let task = readTask(ctx, id);
  if (!task) throw new CoreError("unknown_task", `unknown task ${id}`);
  const available = takeoverAvailability(task);
  if (!available.available) throw new CoreError("conflict", available.reason!);
  const run = task.run!;
  let session = run.agentSession;
  if (!session) {
    try {
      const cfg = loadStrategy(ctx).providers[run.executor];
      if (cfg) {
        const env = executorEnv(ctx.env, await providerEnv(ctx, cfg), id);
        const list = await execProcess({argv:["opencode", "session", "list", "--standalone", "--format", "json", "-n", "20"], cwd:run.workdir, env, timeoutMs:5000});
        const found = list.code === 0 ? parseOpencodeSessions(list.stdout, id) : undefined;
        if (found) session = {id:found, source:"lookup"};
      }
    } catch { /* no discoverable session: use the same explicit refusal below */ }
  }
  if (!session) throw new CoreError("conflict", missingSession(run.executor));
  const at = Date.now() / 1000, request = {at, ...(by ? {by} : {}), sessionId:session.id};
  // Recheck after discovery, before making the request visible to the runner.
  task = readTask(ctx, id)!;
  if (task.run?.dir !== run.dir || !takeoverAvailability(task).available) throw new CoreError("conflict", "The task's active run changed; try again.");
  updateTask(ctx, id, t => {
    if (t.run?.dir !== run.dir || !takeoverAvailability(t).available) throw new CoreError("conflict", "The task's active run changed; try again.");
    writeFileSync(join(run.dir, "takeover.json"), JSON.stringify(request), {mode:0o600, flag:"wx"});
    t.run.agentSession = session;
    t.takeover = {state:"starting", ...request};
  });
  const deadline = Date.now() + 20_000;
  await stopRun(run.dir);
  let live = false;
  while (Date.now() < deadline) {
    const current = readTask(ctx,id);
    if (current?.takeover?.state === "ended") break;
    if (current?.run?.takeover) {
      let path = join(current.run.dir, "session.sock");
      try { path = readFileSync(join(current.run.dir, "session.sock.path"), "utf8").trim(); } catch { /* direct socket */ }
      if (await withTimeout(() => repoFs.access(path), 250).then(() => true, () => false)) { live = true; break; }
    }
    await Bun.sleep(50);
  }
  return {id, state:readTask(ctx,id)?.takeover?.state === "ended" ? "ended" : live ? "driving" : "starting", attach:{cli:`pacer attach ${id} --control`,ws:`/v2/tasks/${id}/session`}};
}
