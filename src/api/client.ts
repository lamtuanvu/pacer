import { callV2Op, v2Hello } from "./v2-compat";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Status } from "../engine/status";
import { DEFAULT_PORT } from "../serve/constants";
import type { LinkSnapshot } from "../link/envelope";
import type { Ctx } from "../types";
import { eventsSince, liveV2Snapshot } from "./events";
import { type OpDeps } from "./ops";
import { toApiError, type ApiEvent } from "./protocol";
import { ApiError, type ApiClient, type Hello } from "./client-types";
import { HttpClient } from "./http-client";
export { ApiError, type ApiClient, type ApiErrorCode, type Hello } from "./client-types";
export { HttpClient } from "./http-client";
export { StdioClient } from "./stdio-client";

export async function connectClient(ctx: Ctx, o: { timeoutMs?: number; opDeps?: OpDeps; protocol?: 2 | 3 } = {}): Promise<ApiClient> {
  if(ctx.env.PACER_WORK_GRANT){
    return new HttpClient(`http://127.0.0.1:${ctx.env.PACER_PORT??DEFAULT_PORT}`,ctx.env.PACER_WORK_GRANT,{protocol:3});
  }
  if(ctx.env.PACER_ROLE==="executor") throw new ApiError("not_allowed","Executor client requires a scoped work grant");
  const fallback = () => new InProcessClient(() => ctx, { opDeps: o.opDeps });
  if (ctx.env.PACER_API === "inprocess") return fallback();
  try {
    const token = readFileSync(join(ctx.pacerHome, "token"), "utf8").trim();
    if (!token) return fallback();
    const base = `http://127.0.0.1:${ctx.env.PACER_PORT ?? DEFAULT_PORT}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 300);
    try {
      const response = await fetch(`${base}/health`, { signal: controller.signal });
      await response.body?.cancel();
      if (response.status === 200 && response.headers.get("x-pacer") === "1") return new HttpClient(base, token, { protocol: o.protocol });
    } finally { clearTimeout(timer); }
  } catch { /* A missing token or unavailable daemon uses the local core. */ }
  return fallback();
}

export class InProcessClient implements ApiClient {
  readonly kind = "inprocess";
  private readonly timers = new Set<ReturnType<typeof setInterval>>();

  constructor(
    private readonly getCtx: () => Ctx,
    private readonly o: { opDeps?: OpDeps; pollMs?: number; status?: (c: Ctx) => Promise<Status> } = {},
  ) {}

  private liveCtx(): Ctx { return { ...this.getCtx(), now: Date.now() / 1000 }; }

  async hello(): Promise<Hello> { return v2Hello(); }

  snapshot(): Promise<{ protocol: string; seq: number; snapshot: LinkSnapshot }> {
    return liveV2Snapshot(this.liveCtx(), { status: this.o.status });
  }

  async call<T = unknown>(op: string, params?: unknown): Promise<T> {
    try { return await callV2Op(this.liveCtx(), op, params, this.o.opDeps) as T; }
    catch (e) {
      const error = toApiError(e);
      throw new ApiError(error.code, error.message, error.hint);
    }
  }

  subscribe(since: number, onEvent: (e: ApiEvent) => void): () => void {
    let last = since;
    const timer = setInterval(() => {
      const batch = eventsSince(this.liveCtx(), last);
      last = batch.last;
      for (const event of batch.events) {
        if (!this.timers.has(timer)) break;
        onEvent(event);
      }
    }, this.o.pollMs ?? 1000);
    this.timers.add(timer);
    return () => { clearInterval(timer); this.timers.delete(timer); };
  }

  close(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}
