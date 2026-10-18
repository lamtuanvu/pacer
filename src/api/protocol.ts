import { CoreError, type CoreErrorCode } from "../core/errors";
import pkg from "../../package.json";
import { opNames } from "./ops";

export const PROTOCOL_VERSION = "3.0.0";

export const PREVIOUS = "2.8.0";
export function helloBody() {
  return { protocol: PROTOCOL_VERSION, previous: PREVIOUS, pacer: pkg.version, ops: opNames(), events: ["task", "mode", "config", "reset", "planner", "executor", "account", "host", "repo", "counts", "attention", "activity", "job", "notify"] };
}

export type ApiErrorCode = CoreErrorCode | "unknown_op" | "too_large" | "internal";
export interface ApiErrorBody { error: { code: ApiErrorCode; message: string; hint?: string; data?: Record<string, unknown> } }
export interface ApiEvent { seq: number; at: number; type: "planner" | "executor" | "account" | "host" | "repo" | "counts" | "attention" | "activity" | "job" | "notify" | "budget" | "task" | "mode" | "alert" | "config" | "reset"; data: unknown }

export type ApiEventV2 = Omit<ApiEvent, "type"> & { type: Exclude<ApiEvent["type"], "planner"> };
export type ApiEventV3 = Omit<ApiEvent, "type"> & { type: Exclude<ApiEvent["type"], "budget" | "alert"> };

const STATUS: Record<ApiErrorCode, number> = {
  invalid_input: 400, not_allowed: 403, unknown_task: 404, unknown_executor: 404, unknown_op: 404, conflict: 409, too_large: 413, internal: 500,
};
export const httpStatus = (code: ApiErrorCode): number => STATUS[code] ?? 500;

/** Errors thrown by ops carry a CoreError code (or "unknown_op"); anything else is internal. */
export function toApiError(e: unknown): ApiErrorBody["error"] {
  if (e instanceof CoreError) return { code: e.code as ApiErrorCode, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.data !== undefined ? { data: e.data } : {}) };
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}

/** JSON-RPC 2.0 error object for a thrown error. */
export function rpcError(e: unknown): { code: number; message: string; data: { code: ApiErrorCode; hint?: string } } {
  const a = toApiError(e);
  return { code: a.code === "unknown_op" ? -32601 : a.code === "invalid_input" ? -32602 : -32000, message: a.message, data: { code: a.code, ...(a.hint ? { hint: a.hint } : {}) } };
}
