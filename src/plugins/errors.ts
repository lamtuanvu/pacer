import { rpcError } from '../api/protocol';
import { CoreError } from '../core/errors';

/** A fixed classification only; never forward arbitrary host error data. */
export function pluginRpcError(error: unknown) {
  const result = rpcError(error);
  if (error instanceof CoreError && error.code === 'capability_denied' && error.data?.reason === 'credential_reflection') {
    return {...result, data: {...result.data, reason: 'credential_reflection' as const}};
  }
  return result;
}
