// unknown_op is an API-layer code carried by CoreError for surface mapping.
export type CoreErrorCode = "unknown_op" | "unknown_task" | "invalid_input" | "unknown_executor" | "conflict" | "not_allowed";

/** The one error type core operations throw. Surfaces map `code` to exit codes, MCP errors or HTTP statuses. */
export class CoreError extends Error {
  constructor(public readonly code: CoreErrorCode, message: string, public readonly hint?: string, public readonly data?: Record<string, unknown>) {
    super(message);
    this.name = "CoreError";
  }
}

export function toCoreError(e: unknown): CoreError {
  if (e instanceof CoreError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "DelegateError") return new CoreError("invalid_input", message);
  if (/^unknown task /.test(message)) return new CoreError("unknown_task", message);
  if (/^unknown kind /.test(message)) return new CoreError("invalid_input", message);
  return new CoreError("invalid_input", message);
}
