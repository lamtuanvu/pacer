import { rpcError } from '../api/errors';
import { CoreError, PluginReportedError, type CoreErrorCode } from '../core/errors';

/** A fixed classification only; never forward arbitrary host error data. */
export function pluginRpcError(error: unknown) {
  const result = rpcError(error);
  if (error instanceof CoreError && error.code === 'capability_denied' && error.data?.reason === 'credential_reflection') {
    return {...result, data: {...result.data, reason: 'credential_reflection' as const}};
  }
  return result;
}

const REPLY_CODES: ReadonlySet<string> = new Set<CoreErrorCode>(['unknown_op', 'unknown_task', 'invalid_input', 'unknown_executor', 'conflict', 'not_allowed', 'plugin_timeout', 'plugin_unavailable', 'plugin_refused', 'capability_denied', 'unknown_plugin', 'not_found', 'too_large']);

/**
 * The error a plugin sent in its JSON-RPC error reply. Any transport that relays such a reply uses this,
 * so a plugin-chosen (or defaulted) code never reads as pacer's own failure.
 */
export function pluginReplyError(error: { message?: string; data?: { code?: string; hint?: string } }): PluginReportedError {
  const code = error.data?.code && REPLY_CODES.has(error.data.code) ? (error.data.code as CoreErrorCode) : 'plugin_unavailable';
  return new PluginReportedError(code, error.message ?? 'plugin error', error.data?.hint);
}
