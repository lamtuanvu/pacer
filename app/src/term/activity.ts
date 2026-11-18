import type { SessionInfo } from '../../../src/session/service';
import type { Delivery, SessionState } from './client';
import { clockParts } from '../../../src/view-model/time';
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
/** A session's real exit time in the strip's lower-case relative form (UI-17): "at 10:24" today, "yesterday at 10:24",
 * "Mon at 10:24" within the week, or "on 2 Nov at 10:24" (with the year when it differs) beyond. Empty when the
 * server could not date the exit. */
export function exitTimeWords(at: unknown, now = Date.now() / 1000): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  const { days, time, weekday, date } = clockParts(at, now);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${weekday} at ${time}`;
  return `on ${date} at ${time}`;
}
/**
 * The strip's exited copy. `waiting` marks a task that still wants an answer while its agent's session has already
 * ended, so answering starts a new attempt: the one actionable fact leads so it survives footer truncation, and the
 * full text stays in the title attribute (UI-15: one fact, plain copy).
 */
export function exitModeWords(
  state: Pick<SessionState, 'code' | 'signal' | 'at'>,
  waiting = false,
  now = Date.now() / 1000,
): string {
  const when = exitTimeWords(state.at, now);
  const hasCode = state.code !== undefined && state.code !== null;
  if (hasCode) {
    const code = `code ${state.code}${state.signal ? ` (${state.signal})` : ''}`;
    if (waiting) return `Answer to start a new attempt · agent exited (${code})${when ? ` ${when}` : ''}`;
    return `Exited with ${code}${when ? ` ${when}` : ''}`;
  }
  // No exit code: an 'at' time still means the session ended, just without a receipt.
  if (waiting) return `Answer to start a new attempt · agent ended${when ? ` ${when}` : ''} · exit code not recorded`;
  return when ? `Ended ${when} · exit code not recorded` : 'Exit not recorded';
}
/** Whether the answer action should be offered for a task state: only `needs_input` (work's checkRestart refuses `running`). */
export function answerRestartsFor(state: string | undefined | null): boolean {
  return state === 'needs_input';
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
