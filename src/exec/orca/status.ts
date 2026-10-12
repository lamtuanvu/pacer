import { type ExecutionCfg, validateExecution } from "../../config/execution";
import { loadStrategy } from "../../config/strategy";
import type { Ctx } from "../../types";
import { OrcaClient, isLiveTerminal, isReady } from "./client";
import { type OrcaWorkerEntry, loadOrcaState } from "./state";

export interface OrcaStatusReport {
  runtime: { ready: boolean; detail: string; version: string | null };
  execution: { ok: true; cfg: ExecutionCfg } | { ok: false; error: string };
  coordinator: { handle: string | null; live: boolean | null };
  run: { id: string | null; found: boolean | null };
  workers: Array<OrcaWorkerEntry & { state: string }>;
}

/** Read-only snapshot: never creates a terminal, run or worker. */
export async function orcaStatus(
  ctx: Ctx, loadExecution: (c: Ctx) => ExecutionCfg = (c) => validateExecution(loadStrategy(c).execution),
): Promise<OrcaStatusReport> {
  const c = new OrcaClient(ctx.run);
  let execution: OrcaStatusReport["execution"];
  try {
    execution = { ok: true, cfg: loadExecution(ctx) };
  } catch (e) {
    execution = { ok: false, error: (e as Error).message };
  }
  const st = await c.status();
  const ready = isReady(st);
  const detail = st.ok
    ? `${st.result.runtime?.state ?? "unknown"}${st.result.runtime?.reachable === false ? " (unreachable)" : ""}`
    : `${st.error.code}: ${st.error.message}`;
  const s = loadOrcaState(ctx);
  const report: OrcaStatusReport = {
    runtime: { ready, detail, version: st.ok ? (st.result.runtime?.appVersion ?? null) : null },
    execution,
    coordinator: { handle: s.coordinator, live: null },
    run: { id: s.run, found: null },
    workers: Object.values(s.workers).map((w) => ({ ...w, state: "unknown" })),
  };
  if (!ready) return report;
  if (s.coordinator) report.coordinator.live = isLiveTerminal(await c.terminalShow(s.coordinator));
  if (s.run) report.run.found = (await c.runShow(s.run)).ok;
  for (const w of report.workers) {
    const ws = await c.workerShow(w.dispatchId);
    w.state = ws.ok ? (ws.result.worker?.state ?? "unknown") : ws.error.code;
  }
  return report;
}

export function renderOrcaStatus(r: OrcaStatusReport): string {
  const lines: string[] = [];
  lines.push(`orca runtime: ${r.runtime.ready ? `ready${r.runtime.version ? ` (Orca ${r.runtime.version})` : ""}` : `not ready (${r.runtime.detail})`}`);
  lines.push(r.execution.ok
    ? `execution: backend ${r.execution.cfg.backend}, worktree ${r.execution.cfg.worktree}, base branch ${r.execution.cfg.baseBranch ?? "(the repo's current branch)"}`
    : `execution: ${r.execution.error}`);
  const live = r.coordinator.live === null ? "not checked" : r.coordinator.live ? "live" : "gone; a new one is created on the next Orca task";
  lines.push(`coordinator: ${r.coordinator.handle ? `${r.coordinator.handle} (${live})` : "none yet (created on the first Orca task)"}`);
  const found = r.run.found === null ? " (not checked)" : r.run.found ? "" : " (not found; a new one is created on the next Orca task)";
  lines.push(`run: ${r.run.id ? `${r.run.id}${found}` : "none yet"}`);
  if (!r.workers.length) {
    lines.push("workers: none");
  } else {
    lines.push("workers:");
    for (const w of r.workers) {
      lines.push(`  ${w.dispatchId}  ${w.taskId}  ${w.executor.padEnd(12)}  ${w.state.padEnd(10)}  ${w.worktree ?? "-"}`);
    }
  }
  return lines.join("\n");
}
