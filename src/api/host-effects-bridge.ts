import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { OpDeps } from "./ops";

const KINDS: readonly string[] = ["host.check", "host.clean", "host.repo.setup"];

/** Native host.check, host.clean and host.repo.setup: Core runs the reference operation of the same name, so its
 * parameter validation, job, SSH effects through the bundled host-runner and remote-caller plugins, host-check and
 * usage-cache writes, errors and reply are those of a forwarded request. The request carries only that operation's
 * params; the remote scripts, argv and one-use grants are derived by Core exactly as for the forwarded call. Callers set
 * no deadline: a forwarded request has none, and setup's local checkout probes and the SSH steps can outlast one. */
export async function hostEffectsBridge(ctx: Ctx, request: unknown, deps: OpDeps = {}): Promise<unknown> {
  const r = request && typeof request === "object" && !Array.isArray(request) ? request as Record<string, unknown> : {};
  if (typeof r.kind !== "string" || !KINDS.includes(r.kind) || Object.keys(r).some(key => key !== "kind" && key !== "params")) {
    throw new CoreError("invalid_input", "host effect required");
  }
  const { callOp } = await import("./ops");
  return callOp(ctx, r.kind, r.params ?? {}, deps);
}
