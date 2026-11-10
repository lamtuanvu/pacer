import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { OpDeps } from "./ops";

function kind(request: unknown): unknown {
  return request && typeof request === "object" && !Array.isArray(request) ? (request as { kind?: unknown }).kind : undefined;
}

/** Native service.install: Rust refused executor, enforcement and work-grant callers and checked consent. Core runs the
 * install transaction, the service manager and the deferred self-reload through the reference operation. */
export async function serviceEffectsBridge(ctx: Ctx, request: unknown, deps: OpDeps = {}): Promise<unknown> {
  if (kind(request) !== "install") throw new CoreError("invalid_input", "service effect required");
  const { callOp } = await import("./ops");
  return callOp(ctx, "service.install", { consent: true }, deps);
}

/** Native update.apply: Core runs the install-method preflight and the shared download/verify/replace/restart job. */
export async function updateEffectsBridge(ctx: Ctx, request: unknown, deps: OpDeps = {}): Promise<unknown> {
  if (kind(request) !== "apply") throw new CoreError("invalid_input", "update effect required");
  const { callOp } = await import("./ops");
  return callOp(ctx, "update.apply", {}, deps);
}
