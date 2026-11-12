import { expect, test } from 'bun:test';
import { clock } from '../src/view-model/time';
import { exitModeWords, exitTimeWords } from '../app/src/term/activity';

const now = 1762960800; // a fixed moment; timezone-independent assertions build on clock()
const today = now - 3600;
const otherDay = now - 7 * 86400 - 3600;

test('an exit time today reads "at 10:24"', () => {
 expect(exitTimeWords(today, now)).toBe(`at ${clock(today, now)}`);
 expect(exitModeWords({ code: 143, at: today }, false, now)).toBe(`Exited with code 143 at ${clock(today, now)}`);
});
test('an exit on another day reads the date (UI-17), not "at" a bare time', () => {
 expect(exitTimeWords(otherDay, now)).toBe(`on ${clock(otherDay, now)}`);
 expect(exitModeWords({ code: 143, at: otherDay }, false, now)).toBe(`Exited with code 143 on ${clock(otherDay, now)}`);
});
test('an exit the server could not date shows no time rather than the viewer open time', () => {
 expect(exitTimeWords(undefined, now)).toBe('');
 expect(exitTimeWords('yesterday', now)).toBe('');
 expect(exitModeWords({ code: 143 }, false, now)).toBe('Exited with code 143');
 expect(exitModeWords({}, false, now)).toBe('Exit not recorded');
});
test('a task that still wants an answer names the dead agent and the new attempt answering starts', () => {
 expect(exitModeWords({ code: 143, at: otherDay }, true, now)).toBe(`Agent not running · exited with code 143 on ${clock(otherDay, now)} · answering starts a new attempt`);
 // A stale socket whose host left no receipt: "exit not recorded", never "code unknown at <now>".
 expect(exitModeWords({ code: null }, true, now)).toBe('Agent not running · exit not recorded · answering starts a new attempt');
 expect(exitModeWords({ code: 143, at: today }, true, now)).toBe(`Agent not running · exited with code 143 at ${clock(today, now)} · answering starts a new attempt`);
});
