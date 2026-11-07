import { addRepo } from "../core/repos";
import type { Ctx } from "../types";
import { toCoreError } from "../core/errors";

export type RepoBridgeOp = "repo.add";

export async function repoBridge(ctx: Ctx, _op: RepoBridgeOp, params: Record<string, unknown>) {
  try {
    const path = params.path;
    if (typeof path !== "string") throw new Error("path required");
    return addRepo(ctx, path);
  } catch (e) {
    throw toCoreError(e);
  }
}
