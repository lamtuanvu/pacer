import type { SessionInfo } from '../../../src/session/service';
import type { Delivery, SessionState } from './client';
import { clock } from '../../../src/view-model/time';
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
/** A session's real exit time as the strip reads it (UI-17): "at 10:24" today, otherwise "on Yesterday 10:24" or "on 11 Nov 16:22". Empty when the server could not date the exit. */
export function exitTimeWords(at: unknown, now = Date.now() / 1000): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  const today = new Date(at * 1000).toDateString() === new Date(now * 1000).toDateString();
  return `${today ? 'at' : 'on'} ${clock(at, now)}`;
}
/**
 * The strip's exited copy. `waiting` marks a task that still wants work or an answer while its agent's session has
 * already ended, so answering plainly starts a new attempt (UI-15: one fact, plain copy).
 */
export function exitModeWords(
  state: Pick<SessionState, 'code' | 'signal' | 'at'>,
  waiting = false,
  now = Date.now() / 1000,
): string {
  const ended =
    state.code === undefined || state.code === null
      ? 'exit not recorded'
      : `exited with code ${state.code}${state.signal ? ` (${state.signal})` : ''}`;  const when = exitTimeWords(state.at, now);
  const detail = `${ended}${when ? ` ${when}` : ''}`;
  return waiting ? `Agent not running · ${detail} · answering starts a new attempt` : `${detail[0]!.toUpperCase()}${detail.slice(1)}`;
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
