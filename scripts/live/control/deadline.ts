import { ControlError } from "./contract";
export interface OperationContext {
  deadline_ms: number;
  signal: AbortSignal;
  check(): void;
  remaining(): number;
  read<T>(operation: () => Promise<T>): Promise<T>;
}
export function operationContext(timeoutMs: number): { context: OperationContext; close(): void } {
  const controller = new AbortController();
  const deadline_ms = Date.now() + timeoutMs;
  const expired = () => new ControlError("command_timeout", "operation deadline expired");
  const timer = setTimeout(() => controller.abort(expired()), timeoutMs);
  const check = () => { if (controller.signal.aborted || Date.now() >= deadline_ms) throw expired(); };
  const context: OperationContext = {
    deadline_ms, signal: controller.signal, check,
    remaining: () => { check(); return Math.max(1, deadline_ms - Date.now()); },
    read: async operation => {
      check();
      let rejectAbort: (reason: unknown) => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const listener = () => rejectAbort(expired());
      controller.signal.addEventListener("abort", listener, { once: true });
      try {
        const value = await Promise.race([Promise.resolve().then(() => { check(); return operation(); }), aborted]);
        check(); return value;
      } finally { controller.signal.removeEventListener("abort", listener); }
    },
  };
  return { context, close: () => clearTimeout(timer) };
}
