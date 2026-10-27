import { CoreError } from "../core/errors";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { execProcess } from "../exec/process";
import { parseRunnerId } from "../config/runner-id";
import { readRun } from "../supervisor/run";
import { planAgentIdentity } from "./agent-session";
import { inspectOwnedExecutorRun } from "./executor-run-state";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord, RunRef } from "../tasks/types";
import type { Ctx } from "../types";
import type { AgentIdentityInput, AgentIdentityPlan } from "@pacer/plugin";

type Identity = NonNullable<RunRef["agentSession"]>;
type Intent = NonNullable<TaskRecord["nativeIdentityIntent"]>;
interface IdentityDeps {
  plan: (ctx: Ctx, input: AgentIdentityInput) => Promise<AgentIdentityPlan>;
  command: (argv: string[], workdir: string, env: Record<string, string | undefined>) =>
    Promise<{ code: number; timedOut: boolean; stdout: string }>;
}
const defaults: IdentityDeps = {
  plan: planAgentIdentity,
  command: (argv, cwd, env) => execProcess({ argv, cwd, env, timeoutMs: 15_000 }),
};
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** Journal native identity before external create; a lost create receipt is never replayed. */
export async function admitOwnedConversationIdentity(ctx: Ctx, taskId: string, providerId: string,
  executor: string, input: AgentIdentityInput, workdir: string, env: Record<string, string | undefined>,
  deps: IdentityDeps = defaults): Promise<Identity | undefined> {
  const task = readTask(ctx, taskId), attempt = (task?.attempts.length ?? 0) + 1;
  if (!task || task.state !== "running" || task.stopPending || task.run ||
    task.interactionMode !== "conversation" || task.executorProvider !== providerId ||
    task.executor !== executor || input.taskId !== taskId || !task.conversation ||
    parseRunnerId(executor)?.agent !== input.agent || parseRunnerId(executor)?.host ||
    !["codex", "claude-code", "opencode"].includes(input.agent))
    throw new CoreError("capability_denied", "conversation identity owner changed");
  const requestedId = task.conversation.agentSessionId;
  const existing = task.nativeIdentityIntent;
  if (existing) {
    if (existing.attempt !== attempt || existing.providerId !== providerId ||
      existing.executor !== executor || existing.workdir !== workdir ||
      existing.requestedId !== requestedId && existing.id !== requestedId)
      throw new CoreError("conflict", "conversation identity intent changed owner");
    if (existing.id && existing.source) return { id: existing.id, source: existing.source };
    if (existing.kind === "create")
      throw new CoreError("conflict", "native session creation has no receipt; replacement refused");
    if (existing.kind === "header") return undefined;
  }
  const plan = await deps.plan(ctx, { ...input, taskId,
    ...(requestedId ? { sessionId: requestedId } : {}) });
  if (input.agent === "opencode" && plan.kind !== "command" ||
    input.agent === "claude-code" && plan.kind !== "assigned" ||
    input.agent === "codex" && plan.kind !== (requestedId ? "assigned" : "none"))
    throw new CoreError("plugin_refused", "native identity plan changed kind");
  if (plan.kind === "none" && (requestedId || input.agent !== "codex"))
    throw new CoreError("plugin_refused", "native conversation identity cannot be recovered");
  if (plan.kind === "command") {
    const expected = requestedId ? ["opencode", "api", "--standalone", "session.get", "--param", `sessionID=${requestedId}`]
      : ["opencode", "api", "--standalone", "session.create", "--data", JSON.stringify({
        title: `pacer ${taskId}`, agent: "build", ...(input.model ? { model: (() => {
          const slash = input.model.indexOf("/");
          if (slash < 1 || slash === input.model.length - 1)
            throw new CoreError("invalid_input", "invalid native conversation model");
          return { providerID: input.model.slice(0, slash), id: input.model.slice(slash + 1) };
        })() } : {}),
      })];
    if (input.agent !== "opencode" || JSON.stringify(plan.argv) !== JSON.stringify(expected) ||
      JSON.stringify(plan.idPath) !== JSON.stringify(["data", "id"]))
      throw new CoreError("plugin_refused", "native identity command is outside the fixed adapter plan");
  }
  if (plan.kind === "assigned" && (!validId(plan.id) || requestedId && requestedId !== plan.id))
    throw new CoreError("plugin_refused", "native conversation identity was not verified");
  const kind: Intent["kind"] = plan.kind === "none" ? "header" :
    plan.kind === "assigned" ? "assigned" : requestedId ? "lookup" : "create";
  const intent = withTaskLock(ctx, taskId, () => {
    const current = readTask(ctx, taskId), prior = current?.nativeIdentityIntent;
    if (!current || current.state !== "running" || current.stopPending || current.run ||
      current.interactionMode !== "conversation" || current.executorProvider !== providerId ||
      current.executor !== executor || current.attempts.length + 1 !== attempt ||
      current.conversation?.agentSessionId !== requestedId ||
      prior && (prior.attempt !== attempt || prior.providerId !== providerId ||
        prior.executor !== executor || prior.workdir !== workdir || prior.kind !== kind ||
        prior.requestedId !== requestedId))
      throw new CoreError("conflict", "conversation identity changed before admission");
    if (prior?.id && prior.source) return prior;
    if (prior?.kind === "create")
      throw new CoreError("conflict", "native session creation has no receipt; replacement refused");
    if (prior) return prior;
    const created: Intent = { attempt, providerId, executor, workdir, kind,
      ...(requestedId ? { requestedId } : {}),
      ...(plan.kind === "assigned" ? { id: plan.id, source: requestedId ? "lookup" : "assigned" } : {}) };
    updateTask(ctx, taskId, record => {
      record.nativeIdentityIntent = created;
      if (created.id) record.conversation = { ...record.conversation!, agentSessionId: created.id };
    });
    return created;
  });
  if (intent.id && intent.source) return { id: intent.id, source: intent.source };
  if (kind === "header") return undefined;
  let id: unknown;
  if (plan.kind === "assigned") id = plan.id;
  else if (plan.kind === "command") {
    if (plan.argv.length < 1 || plan.argv.length > 16 ||
      plan.argv.some(value => !value || value.length > 4096 || value.includes("\0")))
      throw new CoreError("plugin_refused", "native identity command is invalid");
    const result = await deps.command(plan.argv, workdir, env);
    try {
      id = JSON.parse(result.stdout);
      for (const key of plan.idPath) id = id && typeof id === "object" &&
        Object.hasOwn(id, key) ? (id as Record<string, unknown>)[key] : undefined;
    } catch { id = undefined; }
    if (result.code !== 0 || result.timedOut) id = undefined;
  }
  if (!validId(id) || requestedId && requestedId !== id)
    throw new CoreError("plugin_refused", "native conversation identity was not verified");
  const source: Identity["source"] = requestedId ? "lookup" : "assigned";
  return withTaskLock(ctx, taskId, () => {
    const current = readTask(ctx, taskId), pending = current?.nativeIdentityIntent;
    if (!current || current.state !== "running" || current.stopPending || current.run ||
      current.executorProvider !== providerId || current.executor !== executor ||
      current.attempts.length + 1 !== attempt || !pending ||
      pending.kind !== kind || pending.providerId !== providerId ||
      pending.executor !== executor || pending.workdir !== workdir ||
      pending.requestedId !== requestedId || pending.id)
      throw new CoreError("conflict", "native conversation identity changed after admission");
    updateTask(ctx, taskId, record => {
      record.nativeIdentityIntent = { ...pending, id, source };
      record.conversation = { ...record.conversation!, agentSessionId: id };
    });
    return { id, source };
  });
}

function firstBytes(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return undefined; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid?.() !== undefined && stat.uid !== process.getuid()))
      return undefined;
    const bytes = Buffer.alloc(16 * 1024);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
  } finally { closeSync(fd); }
}

/** Bind a fresh Codex native ID only after the same started wrapper emitted it. */
export function discoverOwnedConversationIdentity(ctx: Ctx, taskId: string,
  providerId: string, attempt: number): Identity | undefined {
  const task = readTask(ctx, taskId), run = task?.run, intent = task?.nativeIdentityIntent;
  if (!task || !run || task.state !== "running" || task.stopPending ||
    task.interactionMode !== "conversation" || task.executorProvider !== providerId ||
    run.session !== "interactive" || run.interactionMode !== "conversation" || run.host ||
    run.attempt !== attempt || task.attempts.length + 1 !== attempt ||
    !intent || intent.kind !== "header" || intent.attempt !== attempt ||
    intent.providerId !== providerId || intent.executor !== run.executor ||
    intent.workdir !== run.workdir || task.startIntent?.dir !== run.dir ||
    task.startIntent.providerId !== providerId || task.startIntent.attempt !== attempt)
    throw new CoreError("conflict", "conversation identity has no owned wrapper");
  const observed = inspectOwnedExecutorRun(ctx, taskId, attempt);
  if (observed.dir !== run.dir || observed.startedAt !== run.startedAt)
    throw new CoreError("conflict", "conversation native identity wrapper changed");
  if (intent.id && intent.source) return { id: intent.id, source: intent.source };
  const hook = firstBytes(join(run.dir, "agent-session-id"))?.trim();
  const header = `${firstBytes(join(run.dir, "stdout")) ?? ""}\n${firstBytes(join(run.dir, "stderr")) ?? ""}`;
  const id = validId(hook) ? hook :
    /(?:^|\n)\s*session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i.exec(header ?? "")?.[1];
  if (!validId(id)) return undefined;
  const source: Identity["source"] = validId(hook) ? "lookup" : "header";
  return withTaskLock(ctx, taskId, () => {
    const current = readTask(ctx, taskId), owner = current?.run, pending = current?.nativeIdentityIntent;
    if (!current || !owner || current.state !== "running" || current.stopPending ||
      current.executorProvider !== providerId || current.attempts.length + 1 !== attempt ||
      owner.dir !== run.dir || owner.startedAt !== run.startedAt ||
      readRun(owner.dir).startedAt !== run.startedAt ||
      pending?.kind !== "header" || pending.attempt !== attempt ||
      pending.providerId !== providerId || pending.executor !== owner.executor ||
      pending.workdir !== owner.workdir || pending.id && pending.id !== id ||
      current.conversation?.agentSessionId && current.conversation.agentSessionId !== id)
      throw new CoreError("conflict", "conversation native identity changed before publication");
    updateTask(ctx, taskId, record => {
      record.nativeIdentityIntent = { ...pending, id, source };
      record.run!.agentSession = { id, source };
      record.conversation = { ...record.conversation!, agentSessionId: id };
    });
    return { id, source };
  });
}
