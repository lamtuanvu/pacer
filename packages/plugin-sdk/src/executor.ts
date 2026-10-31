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

/** 1.10.0 Orca terminal-worker attempt. The host issues every Orca effect through the task-owned `capability.orca.*` methods. */
export interface ExecutorOrcaRunInput {
  task: { id: string; rev: number }; attempt: number; runDir: 1;
  orca: { executor: string; model: string | null; timeoutMs: number; session?: "interactive" };
}
/** Before any worker can exist, an Orca provider may hand the attempt back to the host's logged direct route or refuse it. */
export type ExecutorOrcaDisposition = { orca: { fallback: { reason: string } } } | { orca: { refused: { reason: string } } };
