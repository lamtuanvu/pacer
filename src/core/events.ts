import { publish } from "../link/publish";
import type { Ctx } from "../types";

/** Configuration changes refresh API clients without sending channel messages. */
export function publishConfigChange(ctx: Ctx, area: string) {
  return publish(ctx, [{v: 1, type: "config", data: {area, at: ctx.now}}], {channel: false});
}
