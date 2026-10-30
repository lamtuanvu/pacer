export { httpStatus, toApiError, rpcError, type ApiErrorCode, type ApiErrorBody } from "./errors";
import pkg from "../../package.json";
import { opNames } from "./ops";

export const PROTOCOL_VERSION = "3.0.0";

export const PREVIOUS = "2.8.0";
export function helloBody() {
  return { protocol: PROTOCOL_VERSION, previous: PREVIOUS, pacer: pkg.version, ops: opNames(), events: ["desktop.update", "plugin", "pause", "task", "mode", "config", "reset", "planner", "executor", "account", "host", "repo", "counts", "attention", "activity", "job", "notify", "machine", "assistant", "discovery.found"] };
}

export interface ApiEvent { seq: number; at: number; type: "desktop.update" | "plugin" | "pause" | "planner" | "executor" | "account" | "host" | "repo" | "counts" | "attention" | "activity" | "job" | "notify" | "machine" | "budget" | "task" | "mode" | "alert" | "config" | "reset" | "assistant" | "discovery.found"; data: unknown }

export type ApiEventV2 = Omit<ApiEvent, "type"> & { type: Exclude<ApiEvent["type"], "planner" | "desktop.update" | "assistant" | "machine" | "discovery.found"> };
export type ApiEventV3 = Omit<ApiEvent, "type"> & { type: Exclude<ApiEvent["type"], "budget" | "alert"> };
