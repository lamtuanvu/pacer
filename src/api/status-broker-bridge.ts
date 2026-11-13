import { z } from "zod";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { computeStatus, statusBrokerParts } from "../engine/status";
import { draftStatuses } from "../strategy/service";
import type { Ctx } from "../types";
import { draft as strategyDraft } from "./ops";

/**
 * Params of the sealed usage-broker parts route: the HTTP `/_internal/status-broker-parts` body and the stdio
 * `_internal.status-broker.parts` params beside `key`. Every field is optional and any other field is refused.
 * - none (`{}`): the active strategy's `computeStatus` parts.
 * - `cacheOnly: true`: the same parts from the usage readings already cached in memory, read-only; no usage source is
 *   read and nothing is written.
 * - `draft` (a `strategy.preview` draft): `{current, draft}` parts from `strategy.preview`'s two read-only statuses,
 *   which share one readings map. `errors` (preview's error list) replaces `draft` when the draft fails. Combines
 *   with `cacheOnly`.
 */
const params = z.object({ draft: strategyDraft.optional(), cacheOnly: z.boolean().optional() }).strict();

export async function statusBrokerPartsFor(ctx: Ctx, input: unknown) {
  const parsed = params.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map(i => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  const { draft, cacheOnly } = parsed.data;
  if (draft) {
    const statuses = await draftStatuses(ctx, draft, { cacheOnly });
    return { current: statusBrokerParts(statuses.currentStatus),
      ...(statuses.draft ? { draft: statusBrokerParts(statuses.draft.status) } : { errors: statuses.errors }) };
  }
  const strategy = loadStrategy(ctx);
  return statusBrokerParts(await (cacheOnly ? computeStatus({ ...ctx, readOnly: true }, strategy, { cacheOnly: true }) : computeStatus(ctx, strategy)));
}
