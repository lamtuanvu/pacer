import { checkSetup } from "../setup/check";
import type { Ctx } from "../types";
import { toCoreError } from "../core/errors";

export async function setupCheckBridge(ctx: Ctx, snapshotProbe: boolean) {
  try {
    return await checkSetup(ctx, { snapshotProbe });
  } catch (e) {
    throw toCoreError(e);
  }
}
