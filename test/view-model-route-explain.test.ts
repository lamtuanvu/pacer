import { expect, test } from 'bun:test';
import { REASON_CODES } from '../src/dispatch/reasons';
import { explainHeadline, plannerCopy, reasonCopy } from '../src/view-model/route-explain';

const labels = { executor: (id: string) => id.toUpperCase(), step: (id: string) => `step ${id}`, now: 0 };

test('every dispatch.explain reason code has plain copy without the code or raw facts', () => {
  for (const code of REASON_CODES) {
    const text = reasonCopy({ code, outcome: 'info', facts: { stepId: 'a', executor: 'codex', requested: 'codex', host: 'box', used: 1, limit: 2, headroomPct: 40, samples: 3, needed: 20, validation: 'invalid' } }, labels);
    expect(text).not.toBe('Another condition applies.');
    if (code.includes('_')) expect(text).not.toContain(code);
    expect(text).not.toContain('undefined');
  }
});
test('unknown codes get generic copy, and labels name executors and steps', () => {
  expect(reasonCopy({ code: 'added_later', outcome: 'info', facts: {} }, labels)).toBe('Another condition applies.');
  expect(reasonCopy({ code: 'step_match', outcome: 'pass', facts: { stepId: 'fast', kind: 'debug' } }, labels)).toBe('It matched the step fast step for debug tasks.');
  expect(reasonCopy({ code: 'override_unavailable', outcome: 'fail', facts: { requested: 'codex', reason: 'quota_exhausted' } }, labels)).toBe("CODEX cannot take the task, so the ladder's choice is used instead.");
  expect(reasonCopy({ code: 'executor_busy', outcome: 'fail', facts: {} }, labels)).toContain('an unknown number of');
});
test('headline and planner cost follow the outcome', () => {
  const chosen = { executor: 'codex', account: 'a', runner: 'codex', model: { kind: 'executor-default' as const }, host: null };
  expect(explainHeadline({ outcome: 'select', chosen }, labels)).toBe('Pacer would choose CODEX');
  expect(explainHeadline({ outcome: 'override', chosen }, labels)).toBe('CODEX, as you asked');
  expect(explainHeadline({ outcome: 'queue', chosen: null }, labels)).toBe('Pacer would queue this task');
  // The runner, not the agent, names the choice, so two accounts of one agent stay distinct.
  expect(explainHeadline({ outcome: 'select', chosen: { ...chosen, runner: 'codex#team' } }, labels)).toBe('Pacer would choose CODEX#TEAM');
  expect(explainHeadline({ outcome: 'fail', chosen: null }, labels)).toBe('No executor can take this task');
  expect(plannerCopy({ state: 'unknown', reason: 'too_few_samples' }, labels)).toContain('not enough similar reviewed tasks');
  expect(plannerCopy({ state: 'estimate', tokens: { median: 1200, p80: 3400 }, samples: 25, basis: 'kind', window: null }, labels)).toBe('Planner cost: about 1,200 tokens (80% of tasks under 3,400), from 25 similar tasks.');
});
