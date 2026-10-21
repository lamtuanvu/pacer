import type { LinkSnapshot } from "../link/envelope";
import type { ApiEvent } from "./protocol";

// Kept local so API clients never load the core operation registry at runtime.
export type ApiErrorCode = "not_found" | "unknown_op" | "unknown_task" | "invalid_input" | "unknown_executor" | "conflict" | "not_allowed" | "too_large" | "internal"
  | "plugin_timeout" | "plugin_unavailable" | "plugin_refused" | "capability_denied" | "unknown_plugin";

export type Hello = { protocol: string; previous?: string; pacer: string; ops: string[]; events: string[] };

export interface ApiClient {
  kind: "inprocess" | "http" | "stdio";
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

