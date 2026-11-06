import { sessionProbeParts } from "./session-probe-bridge";
import { taskDetailEnrichment } from "../core/task-detail";
import type { Ctx } from "../types";

/** Injection payload for native `task.get` (session probe + TypeScript enrichment). */
export async function taskReadParts(ctx: Ctx, id: string) {
  return { ...sessionProbeParts(ctx), enrichment: await taskDetailEnrichment(ctx, id) };
}
