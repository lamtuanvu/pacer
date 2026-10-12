import { loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import type { Status } from "../engine/status";
import { renderHook } from "../render/hook";
import type { Ctx } from "../types";
import { hookInput, plannerPolicyApplies } from "./role";
import { policyText } from "./policy";

export interface SessionDeps { status?: (ctx: Ctx) => Promise<Status> }

export async function sessionStart(ctx: Ctx, planner: string, deps: SessionDeps = {}, stdin = ""): Promise<string> {
  if (!plannerPolicyApplies(ctx, planner, hookInput(stdin))) return "";
  let body: string;
  if ((ctx.env.PACER ?? "").toLowerCase() === "off") {
    body = "pacer delegation policy is OFF for this session (PACER=off). Do the work directly.";
  } else {
    body = policyText(planner);
    try {
      const st = await (deps.status ?? (ctx => computeStatus(ctx, loadStrategy(ctx))))(ctx);
      body += "\n\n" + renderHook(st, planner);
    } catch {
      // Keep policy context available even when budget collection fails.
    }
  }
  return planner === "cursor" ? JSON.stringify({ additional_context: body }) : body;
}
