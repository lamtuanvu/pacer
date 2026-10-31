import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import { OrcaClient, isReady } from "../exec/orca/client";
import type { CallAuthority } from "./authority";
import { ORCA_PROVIDER, type OrcaAttemptSession, orcaSession } from "./orca-attempt";
import { liveAgentProblem, releaseLive } from "./orca-host";

const deny = (why: string): never => { throw new CoreError("capability_denied", why); };

/** The live session behind this call's host-issued attempt; its task must still be running under this attempt. */
function attempt(authority: CallAuthority, pluginId: string, params: { taskId: string; attempt: number }): OrcaAttemptSession {
  const grant = authority.orcaAttemptGrant(params.taskId, params.attempt);
  const session = orcaSession(grant.session);
  if (!session || grant.providerId !== ORCA_PROVIDER || pluginId !== ORCA_PROVIDER || session.task.id !== grant.taskId ||
    session.attempt !== grant.attempt || session.cfg.id !== grant.executor)
    deny("Orca attempt is not owned by this provider call");
  const task = readTask(authority.ctx, grant.taskId);
  if (!task || task.attempts.length + 1 !== grant.attempt) deny("Orca attempt owner changed");
  return session!;
}

/** Live-worker grants name the exact recorded worker and terminal; a changed record refuses the effect. */
function liveWorker(authority: CallAuthority, pluginId: string, params: { taskId: string; attempt: number }, action: "stop" | "inspect") {
  const grant = authority.consumeOrcaLive(params.taskId, params.attempt, action);
  const task = readTask(authority.ctx, grant.taskId);
  if (pluginId !== ORCA_PROVIDER || grant.providerId !== ORCA_PROVIDER || !task?.live || task.live.backend !== "orca" ||
    task.live.worker !== grant.worker || task.live.terminal !== grant.terminal || task.live.incarnation !== grant.incarnation)
    deny("Orca live worker changed");
  return { task: task!, live: task!.live!, why: grant.why ?? "the task was stopped" };
}

/** Answer one task-owned `capability.orca.*` call; every effect goes through the host-held attempt session. */
export async function answerOrca(authority: CallAuthority, pluginId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const ctx = authority.ctx;
  const owner = params as { taskId: string; attempt: number };
  switch (method) {
    case "capability.orca.status": {
      const ready = isReady(await new OrcaClient(ctx.run, ctx.env).status());
      return ready ? { ready } : { ready, reason: "the Orca runtime is not ready (orca status)" };
    }
    case "capability.orca.liveAnswer": return attempt(authority, pluginId, owner).liveAnswer();
    case "capability.orca.prepare": return attempt(authority, pluginId, owner).prepare();
    case "capability.orca.place": return attempt(authority, pluginId, owner).place();
    case "capability.orca.terminal": return attempt(authority, pluginId, owner).createTerminal();
    case "capability.orca.abandon": return attempt(authority, pluginId, owner).abandon(String(params.reason));
    case "capability.orca.start": return attempt(authority, pluginId, owner).startWorker();
    case "capability.orca.lookup": return attempt(authority, pluginId, owner).lookup();
    case "capability.orca.adopt": return attempt(authority, pluginId, owner).adopt();
    case "capability.orca.unstarted": return attempt(authority, pluginId, owner).unstarted();
    case "capability.orca.wait": return attempt(authority, pluginId, owner).wait(authority.signal);
    case "capability.orca.settle": await attempt(authority, pluginId, owner).settle(params.settled === true); return { ok: true };
    case "capability.orca.finish": {
      const m = params as { code: number; timedOut: boolean; settled: boolean; summary: string; tail?: string; launchBroken?: string; keepAlive: boolean };
      return attempt(authority, pluginId, owner).finish({ code: m.code, timedOut: m.timedOut, settled: m.settled, summary: m.summary,
        ...(m.tail === undefined ? {} : { tail: m.tail }), ...(m.launchBroken === undefined ? {} : { launchBroken: m.launchBroken }), keepAlive: m.keepAlive });
    }
    case "capability.orca.stop": {
      const { task, why } = liveWorker(authority, pluginId, owner, "stop");
      await releaseLive(ctx, new OrcaClient(ctx.run, ctx.env), task, why);
      return { code: 0, killed: !readTask(ctx, task.id)?.live };
    }
    case "capability.orca.sessionState": {
      const { live } = liveWorker(authority, pluginId, owner, "inspect");
      const problem = await liveAgentProblem(new OrcaClient(ctx.run, ctx.env), live);
      const state = problem === null ? "running" : /^the worker is |^the terminal is gone$/.test(problem) ? "exited" : "uncertain";
      return { state, handle: live.terminal };
    }
    default: return deny("unknown Orca operation");
  }
}
