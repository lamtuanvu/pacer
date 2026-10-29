import type { Ctx } from "../types";
import type { Seen } from "./state";

/** Hands Pair to a plugin contributing `pairing`. Until that extension point exists, nothing takes it. */
export async function handOver(_ctx: Ctx, _seen: Seen): Promise<{ handedOver: boolean; plugin?: string }> {
  return { handedOver: false };
}
