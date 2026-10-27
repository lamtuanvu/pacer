import { isAbsolute, normalize } from "node:path";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { CallAuthority } from "./authority";
import { consumeOwnedRemotePrepareGrant } from "./executor-remote-prepare";
import { issueConfiguredHostPrepare } from "./host-prepare-issuer";
import { issueConfiguredHostPrepareRecover } from "./host-prepare-recover-issuer";

interface Result { code: number; stdout: string; stderr: string; timedOut: boolean }
interface Broker {
  prepareConfiguredHost(ctx: Ctx, grant: Awaited<ReturnType<typeof issueConfiguredHostPrepare>>,
    signal?: AbortSignal): Promise<Result>;
  recoverConfiguredHostPrepare(ctx: Ctx,
    grant: Awaited<ReturnType<typeof issueConfiguredHostPrepareRecover>>,
    signal?: AbortSignal): Promise<Result>;
}

/** Plugin supplies only its task identity. Host consumes the exact persisted one-use placement. */
export async function answerOwnedRemotePrepare(authority: CallAuthority,
  request: { taskId: string; attempt: number }, broker: Broker): Promise<{ worktree: string; branch: string }> {
  const ctx = authority.ctx;
  const resource = authority.consumeRemotePrepare(request.taskId, request.attempt);
  const intent = consumeOwnedRemotePrepareGrant(ctx, resource.grant);
  if (intent.providerId !== "pacer-exec-direct" || intent.attempt !== request.attempt ||
    (resource.grant.mode === "recover" && resource.bundle !== undefined))
    throw new CoreError("capability_denied", "remote placement grant changed");
  const result = resource.grant.mode === "prepare"
    ? await broker.prepareConfiguredHost(ctx, await issueConfiguredHostPrepare(ctx,
      intent.alias, request.taskId, intent.baseSha, intent.base,
      resource.bundle ?? new Uint8Array()), authority.signal)
    : await broker.recoverConfiguredHostPrepare(ctx,
      await issueConfiguredHostPrepareRecover(ctx, request.taskId), authority.signal);
  if (result.code !== 0 || result.timedOut) throw new CoreError("plugin_refused", "remote placement is unverified");
  const lines = result.stdout.trimEnd().split("\n");
  if (lines.length !== 2 || !lines[0]?.startsWith("worktree=") || !lines[1]?.startsWith("branch="))
    throw new CoreError("plugin_refused", "remote placement returned malformed facts");
  const worktree = lines[0].slice(9), branch = lines[1].slice(7);
  if (!isAbsolute(worktree) || normalize(worktree) !== worktree ||
    !worktree.endsWith(`/.pacer-remote/worktrees/${intent.tag}/${request.taskId}-${request.attempt}`) ||
    ![`pacer/${request.taskId}`, `pacer/${request.taskId}-${request.attempt}`].includes(branch))
    throw new CoreError("plugin_refused", "remote placement returned foreign worktree");
  authority.bindRemotePrepared(request.taskId, request.attempt, worktree, branch);
  return { worktree, branch };
}
