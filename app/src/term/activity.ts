import type { SessionInfo } from '../../../src/session/service';
import type { Delivery } from './client';
/** `active` labels the client that most recently typed or focused a 1.2 session (ADR 0023). */
export type SessionActivity = SessionInfo & { active?: string | null };
export function sessionActive(session?: SessionActivity | null): string | null {
  return typeof session?.active === 'string' && session.active ? session.active : null;
}
/** Host labels read `app:<label>` or `cli:<label>`; only the label is shown. A delivery seen since this pane last typed is named after it. */
export function lastInputWords(active?: string | null, delivered?: Pick<Delivery, 'kind'> | null): string {
  const name = active?.replace(/^(app|cli):/, '').trim();
  const words = name ? `Interactive · last input from ${name}` : 'Interactive';
  return delivered ? `${words} · pacer delivered ${delivered.kind === 'answer' ? 'an answer' : 'a message'}` : words;
}
/**
 * A built-in host on session protocol 1.2 has no controller: every attached pane types (ADR 0023). The service's
 * negotiated minor decides; a connected pane runtime is the fallback only for an older core that omits it.
 */
export function interactiveHost(session?: Pick<SessionInfo, 'host' | 'sessionMinor'> | null, runtimeShared?: boolean): boolean {
  if (!session) return runtimeShared === true;
  if (session.host !== 'builtin') return false;
  return typeof session.sessionMinor === 'number' ? session.sessionMinor >= 2 : runtimeShared === true;
}
