// unknown_op is an API-layer code carried by CoreError for surface mapping.
export type CoreErrorCode = "unknown_op" | "unknown_task" | "invalid_input" | "unknown_executor" | "conflict" | "not_allowed"
  | "not_found" | "too_large" | "unavailable" | "rate_limited"
  | "plugin_timeout" | "plugin_unavailable" | "plugin_refused" | "capability_denied" | "unknown_plugin";

/** The one error type core operations throw. Surfaces map `code` to exit codes, MCP errors or HTTP statuses. */
export class CoreError extends Error {
  constructor(public readonly code: CoreErrorCode, message: string, public readonly hint?: string, public readonly data?: Record<string, unknown>) {
    super(message);
    this.name = "CoreError";
  }
}

/** A plugin's own JSON-RPC error reply. It keeps the code the plugin chose, but the failure is the plugin's. */
export class PluginReportedError extends CoreError {}

/** Errors pacer raised itself (host, registry, bridge, deadlines it enforces), never a plugin's error reply. */
export function raisedByPacer(e: unknown): e is CoreError {
  return e instanceof CoreError && !(e instanceof PluginReportedError);
}

export function toCoreError(e: unknown): CoreError {
  if (e instanceof CoreError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "DelegateError") return new CoreError("invalid_input", message);
  if (/^unknown task /.test(message)) return new CoreError("unknown_task", message);
  if (/^unknown kind /.test(message)) return new CoreError("invalid_input", message);
  return new CoreError("invalid_input", message);
}

export type ApiErrorCode = CoreErrorCode | "unknown_op" | "too_large" | "internal";
export interface ApiErrorBody { error: { code: ApiErrorCode; message: string; hint?: string; data?: Record<string, unknown> } }
const STATUS: Record<ApiErrorCode, number> = {
  not_found: 404, invalid_input: 400, not_allowed: 403, unknown_task: 404, unknown_executor: 404, unknown_op: 404, conflict: 409, too_large: 413, internal: 500, unavailable: 503, rate_limited: 429,
  plugin_timeout: 504, plugin_unavailable: 503, plugin_refused: 422, capability_denied: 403, unknown_plugin: 404,
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