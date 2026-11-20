import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { OpDeps } from "./ops";

function value(request: unknown, key: string): unknown {
  return request && typeof request === "object" && !Array.isArray(request)
    ? (request as Record<string, unknown>)[key]
    : undefined;
}

/** Native onboarding.try over HTTP: Rust refused executor sessions and validated the
 * empty params schema. Core runs the whole tryDelegation through the reference
 * operation, so routing, the scratch git repo, delegate and spawn all use this
 * service's live core. */
export async function onboardingEffectsBridge(
  ctx: Ctx,
  request: unknown,
  deps: OpDeps = {},
): Promise<unknown> {
  const kind = value(request, "kind");
  const { callOp } = await import("./ops");
  if (kind === "onboarding-try") {
    return callOp(ctx, "onboarding.try", {}, deps);
  }
  throw new CoreError("invalid_input", "onboarding effect required");
}