import type { Status } from "../engine/status";
import type { LinkSnapshot } from "../link/envelope";
import type { Ctx } from "../types";
import { eventsSince, liveSnapshot } from "./events";
import { callOp, type OpDeps } from "./ops";
import { helloBody, toApiError, type ApiErrorCode, type ApiEvent } from "./protocol";

export type Hello = { protocol: string; pacer: string; ops: string[]; events: string[] };

export interface ApiClient {
  kind: "inprocess" | "http";
  hello(): Promise<Hello>;
  snapshot(): Promise<{ protocol: string; seq: number; snapshot: LinkSnapshot }>;
  call<T = unknown>(op: string, params?: unknown): Promise<T>;
  subscribe(since: number, onEvent: (e: ApiEvent) => void): () => void;
  close(): void;
}

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, message: string, public hint?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class InProcessClient implements ApiClient {
  readonly kind = "inprocess";
  private readonly timers = new Set<ReturnType<typeof setInterval>>();

  constructor(
    private readonly getCtx: () => Ctx,
    private readonly o: { opDeps?: OpDeps; pollMs?: number; status?: (c: Ctx) => Promise<Status> } = {},
  ) {}

  async hello(): Promise<Hello> { return helloBody(); }

  snapshot(): Promise<{ protocol: string; seq: number; snapshot: LinkSnapshot }> {
    return liveSnapshot(this.getCtx(), { status: this.o.status });
  }

  async call<T = unknown>(op: string, params?: unknown): Promise<T> {
    try { return await callOp(this.getCtx(), op, params, this.o.opDeps) as T; }
    catch (e) {
      const error = toApiError(e);
      throw new ApiError(error.code, error.message, error.hint);
    }
  }

  subscribe(since: number, onEvent: (e: ApiEvent) => void): () => void {
    let last = since;
    const timer = setInterval(() => {
      const batch = eventsSince(this.getCtx(), last);
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
