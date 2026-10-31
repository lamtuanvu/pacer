import { CoreError } from "../core/errors";
import { authorizeWorkGrant, getWork, type WorkNode } from "../dispatch/work";
import { isExecutorSession } from "../install/role";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { ParticipantKind, Relation } from "./types";

const MAX_DEPTH = 64;
export const taskOf = (p: string): string | null => p.startsWith("task:") ? p.slice(5) : null;
export function participantKind(p: string): ParticipantKind {
  return p === "human" ? "human" : p.startsWith("external:") ? "external" : "launched";
}
const clean = (key: string) => key.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);

/** The participant of the planner session this process runs in, from its environment, or null. */
export function plannerParticipant(env: Ctx["env"]): string | null {
  if (env.PACER_PLANNER_SESSION) return `external:${clean(env.PACER_PLANNER_SESSION)}`;
  if (env.CLAUDECODE === "1") return "external:claude-code";
  // Only variables a Codex session sets; others such as CODEX_HOME or CODEX_API_KEY merely configure the CLI.
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) return "external:codex";
  return null;
}

/** The explicit local human path: an interactive terminal that is neither an executor nor a planner session. */
export function localHuman(ctx: Ctx, isTTY = !!process.stdin.isTTY): "human" | undefined {
  return isTTY && !isExecutorSession(ctx) && !plannerParticipant(ctx.env) ? "human" : undefined;
}

/**
 * The caller's participant id. Never taken from request fields.
 * Executor identity comes from PACER_ROLE and PACER_TASK_ID (an accepted exception, see ADR 0011).
 * An unknown local caller is the non-privileged `external:local`; `human` needs app authentication
 * or an explicit `participant: "human"` from the local human path ({@link localHuman}).
 */
export function callerParticipant(ctx: Ctx, deps: { appAuthenticated?: boolean; participant?: string } = {}): { id: string; grant: WorkNode | null } {
  const token = ctx.env.PACER_WORK_GRANT;
  if (token) { const grant = authorizeWorkGrant(ctx, token); return { id: `task:${grant.taskId}`, grant }; }
  if (isExecutorSession(ctx)) {
    const id = ctx.env.PACER_TASK_ID;
    if (!id) throw new CoreError("not_allowed", "Executor identity is unknown", undefined, { reason: "msg_forbidden", layer: "identity" });
    return { id: `task:${id}`, grant: null };
  }
  if (deps.appAuthenticated) return { id: "human", grant: null };
  // A planner session keeps its own identity; an explicit participant applies only outside one.
  const planner = plannerParticipant(ctx.env);
  if (planner) return { id: planner, grant: null };
  if (deps.participant) return { id: deps.participant, grant: null };
  return { id: "external:local", grant: null };
}

export function parentOf(ctx: Ctx, p: string): string | null {
  const id = taskOf(p);
  if (!id) return null;
  const work = getWork(ctx, id);
  if (work?.parentId) return `task:${work.parentId}`;
  const task = readTask(ctx, id);
  if (!task) return null;
  return task.origin ?? (task.source === "ui" ? "human" : task.source === "planner" ? "external:planner" : "human");
}

function ancestors(ctx: Ctx, p: string): string[] {
  const out: string[] = [];
  for (let cur = parentOf(ctx, p); cur && out.length < MAX_DEPTH; cur = parentOf(ctx, cur)) out.push(cur);
  return out;
}

/** The top-most task in the chain, or the participant itself when it is not a task. */
export function rootOf(ctx: Ctx, p: string): string {
  const chain = [p, ...ancestors(ctx, p)].filter(x => taskOf(x));
  return chain.at(-1) ?? p;
}

/**
 * Top-level session: an identified external agent, or a task whose parent is the human.
 * The unidentified `external:local` caller is not top-level (see ADR 0011).
 */
export function isTop(ctx: Ctx, p: string): boolean {
  const kind = participantKind(p);
  if (kind === "external") return p !== "external:local";
  if (kind === "human") return false;
  return parentOf(ctx, p) === "human";
}

export function relation(ctx: Ctx, from: string, to: string): Relation {
  if (from === to) return "self";
  const fromParent = parentOf(ctx, from), toParent = parentOf(ctx, to);
  if (fromParent === to) return "parent";
  if (toParent === from) return "child";
  if (isTop(ctx, from) && isTop(ctx, to)) return "top_peer";
  if (fromParent && fromParent === toParent && fromParent !== "human") return "sibling";
  if (ancestors(ctx, to).includes(from)) return "descendant";
  if (ancestors(ctx, from).includes(to)) return "ancestor";
  if (taskOf(from) && taskOf(to) && rootOf(ctx, from) === rootOf(ctx, to)) return "same_tree";
  return "none";
}
