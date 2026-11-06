import type { Ctx } from "../types";
import { CoreError, toCoreError } from "../core/errors";

/** Identity effects for native `machine.*` (keychain and rotation stay in TypeScript). */
export async function machineBridge(
  ctx: Ctx,
  op: "machine.get" | "machine.set" | "machine.rotate",
  params: Record<string, unknown>,
) {
  try {
    const identity = await import("../identity");
    if (op === "machine.get") {
      return identity.machineView(
        await identity.ensureIdentity(ctx),
        await identity.cloneSuspected(ctx),
      );
    }
    if (op === "machine.set") {
      const name = params.name;
      const expectRev = params.expect_rev;
      if (typeof name !== "string" || typeof expectRev !== "number") {
        throw new CoreError("invalid_input", "invalid machine.set params");
      }
      await identity.setMachineName(ctx, name, expectRev);
      return identity.machineView(
        await identity.ensureIdentity(ctx),
        await identity.cloneSuspected(ctx),
      );
    }
    const { rotateIdentity } = await import("../identity/rotate");
    const r = await rotateIdentity(ctx);
    return { oldId: r.oldId, newId: r.newId };
  } catch (e) {
    throw toCoreError(e);
  }
}
