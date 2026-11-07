import { appendFileSync } from "node:fs";
import { plannerPolicyApplies, plannerSessionStatus } from "../install/role";
import { renderHook } from "../render/hook";
import type { Ctx } from "../types";

export type PlannerKind = "claude-code" | "codex";

export function plannerSessionId(kind: PlannerKind, sessionId: string | undefined): string {
  const clean = sessionId?.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  return `external:${kind}${clean ? `:${clean}` : ""}`;
}

export function plannerEnvExport(kind: PlannerKind, sessionId: string | undefined): string | null {
  const id = plannerSessionId(kind, sessionId);
  return id === `external:${kind}` ? null : `export PACER_PLANNER_SESSION='${id.slice("external:".length)}'\n`;
}

/** SessionStart keeps the existing status hook as the source of budget context. */
export async function sessionHook(ctx: Ctx, kind: PlannerKind, input: unknown, statusOutput?: () => Promise<string>): Promise<{ out: string }> {
  try {
    if (plannerPolicyApplies(ctx, kind, input) && ctx.env.CLAUDE_ENV_FILE) {
      const sid = input && typeof input === "object" && "session_id" in input && typeof input.session_id === "string"
        ? input.session_id : undefined;
      const line = plannerEnvExport(kind, sid);
      if (line) appendFileSync(ctx.env.CLAUDE_ENV_FILE, line, { mode: 0o600 });
    }
  } catch { /* SessionStart must preserve status output when the env file cannot be written. */ }
  return { out: statusOutput ? await statusOutput() : await hookStatus(ctx, kind, input) };
}

/** Same output as `pacer status --hook`. Importing `../cli` here would wait on the entry module's own top-level await and never settle. */
async function hookStatus(ctx: Ctx, kind: PlannerKind, input: unknown): Promise<string> {
  try { return plannerPolicyApplies(ctx, kind, input) ? renderHook(await plannerSessionStatus(ctx, kind), kind) : ""; }
  catch { return "{}"; }
}
