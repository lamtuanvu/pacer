import type { ApiErrorCode } from "../../src/api/protocol";

/** Frozen v3 boundary mappings; compile-time exhaustiveness catches new codes. */
export const apiErrorContract = {
  unknown_op: { http: 404, rpc: -32601 },
  unknown_task: { http: 404, rpc: -32000 },
  invalid_input: { http: 400, rpc: -32602 },
  unknown_executor: { http: 404, rpc: -32000 },
  conflict: { http: 409, rpc: -32000 },
  not_allowed: { http: 403, rpc: -32000 },
  not_found: { http: 404, rpc: -32000 },
  too_large: { http: 413, rpc: -32000 },
  internal: { http: 500, rpc: -32000 },
  plugin_timeout: { http: 504, rpc: -32000 },
  plugin_unavailable: { http: 503, rpc: -32000 },
  plugin_refused: { http: 422, rpc: -32000 },
  capability_denied: { http: 403, rpc: -32000 },
  unknown_plugin: { http: 404, rpc: -32000 },
} as const satisfies Record<ApiErrorCode, { http: number; rpc: number }>;
