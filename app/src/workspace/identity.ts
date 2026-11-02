import type { BrowserApi } from '../data/api';
export async function resolveWorkspaceIdentity(origin: string, ops: ReadonlySet<string>, call: BrowserApi['call']): Promise<string> {
 if (ops.has('machine.get')) {
  try { const result = await call<{id?: string}>('machine.get', {}); if (typeof result?.id === 'string' && result.id) return JSON.stringify([origin, result.id]); } catch { /* Older or unreachable services use the origin. */ }
 }
 return origin;
}
