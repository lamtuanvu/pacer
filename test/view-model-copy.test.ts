import { expect, test } from 'bun:test';
import { clock } from '../src/view-model/format';
import { reasonCopy, costCopy, kindCopy, kindSourceCopy, timelineCopy, sessionTime, branchCopy, executorIdHelp } from '../src/view-model/copy';
const now = Date.parse('2026-10-19T03:24:00Z') / 1000;
test('one clock distinguishes local calendar days, yesterday and a full week', () => {
  const at = (s: string) => Date.parse(s) / 1000;
  const format = (s: string) => clock(at(s), now, 'Asia/Ho_Chi_Minh');
  expect(format('2026-10-19T03:24:00Z')).toBe('10:24');
  expect(format('2026-10-18T03:24:00Z')).toBe('Yesterday 10:24');
  expect(format('2026-10-13T03:24:00Z')).toBe('Tue 10:24');
  expect(format('2026-10-12T03:24:00Z')).toBe('12 Oct 10:24');
  expect(clock(at('2026-10-18T16:59:00Z'), at('2026-10-18T17:01:00Z'), 'Asia/Ho_Chi_Minh')).toBe('Yesterday 23:59');
  expect(clock(at('2026-03-08T06:30:00Z'), at('2026-03-09T04:15:00Z'), 'America/New_York')).toBe('Yesterday 01:30');
});
test('internal routing strings get useful copy with a safe fallback', () => {
  expect(reasonCopy('ok, used 0%; codex busy')).toBe('Available capacity · 0% of quota used; Codex is busy');
  expect(reasonCopy('exhausted')).toBe('Out of quota');
  expect(reasonCopy('unknown_internal_code')).toBe('Routing details available');
  expect(reasonCopy('busy')).toBe('Busy with another task');
});
test('cost, classifier, branch and executor preview copy are plain language', () => {
  expect(costCopy({account:'cursor',deltaPct:0,window:'limit'})).toBe('Cursor · no measured quota increase');
  expect(costCopy({account:'codex',deltaPct:2,window:'weekly'})).toBe('Codex · used 2% of weekly quota');
  expect(costCopy({account:'cursor',deltaPct:null,window:null,reason:'shared'})).toContain('shared');
  expect(kindCopy('unfamiliar-code')).toBe('Explore unfamiliar code');
  expect(kindCopy('new_enum')).toBe('Other work');
  expect(kindSourceCopy('brief')).toBe('Chosen in the task brief');
  expect(kindSourceCopy('classifier')).toBe('Suggested from the task description');
  expect(branchCopy(null)).toBe('Branch not recorded');
  expect(executorIdHelp(false)).toContain('final id');
});
test('timeline names and hooks map once; raw unknown events stay out of visible copy', () => {
  expect(timelineCopy([{at:1,text:'hook: PostToolUse'},{at:1,text:'hook: PostToolUse'},{at:2,text:'Testing'},{at:3,text:'partial'},{at:4,text:'raw_internal'}]).map(e=>e.text)).toEqual(['Agent finished a tool step','Running checks','Run ended with work to review','Session activity recorded']);
});
test('session durations describe running time or time since a terminal update', () => {
  expect(sessionTime({state:'running',attemptStartedAt:now-1500,updatedAt:now},now)).toBe('running for 25m');
  expect(sessionTime({state:'partial',attemptStartedAt:now-3000,updatedAt:now-1500},now)).toBe('last updated 25m ago');
  expect(sessionTime({state:'queued',updatedAt:now-60},now)).toBe('queued for 1m');
});

test('unknown values including object property names never bypass copy fallbacks',()=>{
  for(const value of ['constructor','__proto__','toString']) {
    expect(kindCopy(value)).toBe('Other work');
    expect(timelineCopy([{at:1,text:value}])[0]!.text).toBe('Session activity recorded');
    expect(costCopy({account:'cursor',deltaPct:2,window:value})).toBe('Cursor · used 2% of quota');
  }
});
