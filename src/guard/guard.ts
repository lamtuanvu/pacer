import { isExecutorSession, plannerPolicyApplies } from "../install/role";
import { guardEventId } from "../classify/state";
import { appendLabel } from "../tasks/labels";
import { activeHooks } from "../classify/active";
import type { DecisionHooks, GuardInput } from "../classify/hooks";
import { loadStrategy } from "../config/strategy";
import { computeStatus, displayName, type Status } from "../engine/status";
import type { Ctx } from "../types";
import { isObj } from "../util";

export const GUARD_PLANNERS = ["claude-code", "codex", "cursor"] as const;
const ALLOW_TYPES = ["Explore", "Plan", "claude-code-guide", "statusline-setup",
  "*reviewer*", "*analyzer*", "pr-review-toolkit:*", "pacer-*", "pacer:*"];

export interface GuardDeps {
  hooks?: DecisionHooks;
  status?: (ctx: Ctx) => Promise<Status>;
  timeoutMs?: number;
}
export interface GuardDecision { allow: boolean; reason?: string; source?: string }

/** Only * is a wildcard; all other regexp characters in agent names are literal. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`, "i").test(value);
}

export function parseGuardInput(planner: string, raw: unknown): GuardInput | null {
  if (!isObj(raw)) return null;
  if (planner === "cursor") {
    return {
      subagentType: typeof raw.subagent_type === "string" ? raw.subagent_type : "generalPurpose",
      prompt: typeof raw.task === "string" ? raw.task : "",
      ...(typeof raw.subagent_model === "string" ? { model: raw.subagent_model } : {}),
    };
  }
  const tools = planner === "claude-code" ? ["Agent", "Task"] : planner === "codex" ? ["spawn_agent", "Agent"] : [];
  if (typeof raw.tool_name !== "string" || !tools.includes(raw.tool_name)) return null;
  const fields = isObj(raw.tool_input) ? raw.tool_input : {};
  const type = planner === "codex" ? fields.agent_type : fields.subagent_type;
  const prompt = planner === "codex" ? fields.message : fields.prompt;
  return {
    subagentType: typeof type === "string" ? type : planner === "codex" ? "default" : "general-purpose",
    prompt: typeof prompt === "string" ? prompt : "",
  };
}

export async function decideGuard(ctx: Ctx, input: GuardInput, deps: GuardDeps = {}): Promise<GuardDecision> {
  if (isExecutorSession(ctx) || (ctx.env.PACER ?? "").toLowerCase() === "off") return { allow: true };
  const id = guardEventId(input);
  const verdict = (decision: GuardDecision, source: string): GuardDecision => {
    try {
      appendLabel(ctx, { type: "guard_verdict", event_id: id, blocked: !decision.allow, source });
    } catch {
      // Ground-truth logging must never change the guard's decision.
    }
    return decision;
  };
  const opinion = await (deps.hooks ?? activeHooks).guard(ctx, input).catch(() => null);
  if (opinion?.allow) return verdict({ allow: true, source: "classifier" }, "classifier");
  if (!opinion && ALLOW_TYPES.some((pattern) => globMatch(pattern, input.subagentType))) return verdict({ allow: true }, "rules");

  const st = await (deps.status ? deps.status(ctx) : computeStatus(ctx, loadStrategy(ctx)));
  if (!opinion && st.providers.some((provider) =>
    input.subagentType.toLowerCase() === `${provider.id}-executor`.toLowerCase())) return verdict({ allow: true }, "rules");
  if (st.mode === "relaxed" || !st.executors.ranked.length) return verdict({ allow: true }, "rules");

  const planner = displayName(st.planner);
  let reason = `pacer: '${input.subagentType}' is a ${planner} subagent, so it spends ${planner}'s own quota (mode: ${st.mode}). Delegate execution work with the pacer MCP tool \`delegate\` (top executor now: ${st.executors.ranked[0].id}) and a self-contained brief: goal, absolute repo path, scope, acceptance command. If this needs planner-level judgement (design, review), do it in the main conversation, or ask the user to start the session with PACER=off.`;
  if (opinion?.reason) reason += ` (${opinion.reason})`;
  reason += ` (pacer event ${id}: if this block was wrong, call the pacer MCP tool guard_feedback with event_id "${id}" and correct=false)`;
  return verdict({ allow: false, reason }, opinion ? "classifier" : "rules");
}

export function renderGuard(planner: string, decision: GuardDecision): string {
  if (planner === "cursor") return JSON.stringify(decision.allow
    ? { permission: "allow" }
    : { permission: "deny", user_message: decision.reason });
  if (decision.allow) return "";
  return JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason,
  } });
}

async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runGuard(ctx: Ctx, planner: string, stdin: string, deps: GuardDeps = {}): Promise<string> {
  if (!(GUARD_PLANNERS as readonly string[]).includes(planner)) return "";
  const allow: GuardDecision = { allow: true };
  try {
    const raw = JSON.parse(stdin);
    if (!plannerPolicyApplies(ctx, planner, raw)) return renderGuard(planner, allow);
    const input = parseGuardInput(planner, raw);
    const decision = input
      ? await withTimeout(decideGuard(ctx, input, deps), deps.timeoutMs ?? 10000, allow)
      : allow;
    return renderGuard(planner, decision);
  } catch {
    return renderGuard(planner, allow);
  }
}
