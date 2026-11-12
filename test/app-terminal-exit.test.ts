import { expect, test } from 'bun:test';
import { answerRestartsFor, exitModeWords, exitTimeWords } from '../app/src/term/activity';

// A fixed moment. `at` values below are built from local calendar components (same wall-clock each day), so the
// assertions hold in any timezone without calling the production clock() (which would be a tautology).
const now = 1762960800;
const base = new Date(now * 1000);
const hhmm = base.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
// A timestamp `daysAgo` local calendar days before base, keeping base's local wall-clock time.
const at = (daysAgo: number) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() - daysAgo, base.getHours(), base.getMinutes(), base.getSeconds()).getTime() / 1000;
const weekday = (t: number) => new Date(t * 1000).toLocaleDateString('en-GB', { weekday: 'short' });
const ddMon = (t: number) => {
  const d = new Date(t * 1000);
  const sameYear = d.getFullYear() === base.getFullYear();
  return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}${sameYear ? '' : ` ${d.getFullYear()}`}`;
};

test('an exit today reads "at 10:24"', () => {
  expect(exitTimeWords(at(0), now)).toBe(`at ${hhmm}`);
  expect(exitModeWords({ code: 143, at: at(0) }, false, now)).toBe(`Exited with code 143 at ${hhmm}`);
});
test('an exit yesterday reads "yesterday at 10:24"', () => {
  expect(exitTimeWords(at(1), now)).toBe(`yesterday at ${hhmm}`);
  expect(exitModeWords({ code: 143, at: at(1) }, false, now)).toBe(`Exited with code 143 yesterday at ${hhmm}`);
});
test('an exit within the week reads "Mon at 10:24"', () => {
  expect(exitTimeWords(at(3), now)).toBe(`${weekday(at(3))} at ${hhmm}`);
  expect(exitModeWords({ code: 143, at: at(3) }, false, now)).toBe(`Exited with code 143 ${weekday(at(3))} at ${hhmm}`);
});
test('an exit beyond the week reads "on 2 Nov at 10:24"', () => {
  expect(exitTimeWords(at(10), now)).toBe(`on ${ddMon(at(10))} at ${hhmm}`);
  expect(exitModeWords({ code: 143, at: at(10) }, false, now)).toBe(`Exited with code 143 on ${ddMon(at(10))} at ${hhmm}`);
});
test('an exit the server could not date shows no time rather than the viewer open time', () => {
  expect(exitTimeWords(undefined, now)).toBe('');
  expect(exitTimeWords('yesterday', now)).toBe('');
  expect(exitTimeWords(0, now)).toBe('');
  expect(exitModeWords({ code: 143 }, false, now)).toBe('Exited with code 143');
  expect(exitModeWords({}, false, now)).toBe('Exit not recorded');
});
test('a session whose host left no receipt but an end time reads "Ended … · exit code not recorded"', () => {
  expect(exitModeWords({ code: null, at: at(0) }, false, now)).toBe(`Ended at ${hhmm} · exit code not recorded`);
  expect(exitModeWords({ code: null }, false, now)).toBe('Exit not recorded');
});
test('a task that still wants an answer leads with the action so it survives footer truncation', () => {
  expect(exitModeWords({ code: 143, at: at(1) }, true, now)).toBe(`Answer to start a new attempt · agent exited (code 143) yesterday at ${hhmm}`);
  expect(exitModeWords({ code: 143 }, true, now)).toBe('Answer to start a new attempt · agent exited (code 143)');
  expect(exitModeWords({ code: null, at: at(0) }, true, now)).toBe(`Answer to start a new attempt · agent ended at ${hhmm} · exit code not recorded`);
  expect(exitModeWords({ code: null }, true, now)).toBe('Answer to start a new attempt · agent ended · exit code not recorded');
});
test('the answer action is offered only for a task waiting on input, never running', () => {
  expect(answerRestartsFor('needs_input')).toBe(true);
  for (const state of ['running', 'queued', 'done', 'failed', undefined, null]) {
    expect(answerRestartsFor(state)).toBe(false);
  }
});