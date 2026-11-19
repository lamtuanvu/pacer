import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { OpDeps } from "./ops";

function value(request: unknown, key: string): unknown {
  return request && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>)[key]
    : undefined;
}

/** Native service.handover over HTTP: Rust refused the enforcement identity, validated wait_s and
 * checked work-grant callers forward. Core runs the handover wait through the reference operation,
 * so older runners hand their live attempts to this service's version. */
export async function handoverEffectsBridge(ctx: Ctx, request: unknown, deps: OpDeps = {}): Promise<unknown> {
  const kind = value(request, "kind");
  const { callOp } = await import("./ops");
  if (kind === "handover") {
    const waitS = value(request, "wait_s");
    return callOp(ctx, "service.handover", { wait_s: waitS }, deps);
  }
  if (kind === "work") {
    return callOp(ctx, "service.work", {}, deps);
  }
  throw new CoreError("invalid_input", "handover effect required");
}