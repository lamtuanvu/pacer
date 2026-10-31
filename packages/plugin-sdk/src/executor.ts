import type { Handler } from "./index";

/** Staged direct-executor availability input. No raw strategy config or secrets cross the wire. */
export interface ExecutorAvailableInput { strategy: { name: string } }
export interface ExecutorAvailableResult { available: boolean; reason?: string }
export type ExecutorAvailableHandler = (input: ExecutorAvailableInput, signal: AbortSignal) =>
  ExecutorAvailableResult | Promise<ExecutorAvailableResult>;

/** Bind a typed availability callback to the generic plugin server. */
export function executorAvailableHandler(available: ExecutorAvailableHandler): Record<"executor.available", Handler> {
  return { "executor.available": (params, _host, signal) => available(params as ExecutorAvailableInput, signal) };
}
