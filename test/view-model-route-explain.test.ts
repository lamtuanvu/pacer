import { expect, test } from 'bun:test';
import { REASON_CODES, type ReasonFacts } from '../src/dispatch/reasons';
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
  expect(reasonCopy({ code: 'override_unavailable', outcome: 'fail', facts: { requested: 'codex', reason: 'quota_exhausted' } }, labels)).toBe("CODEX cannot take this task.");
  expect(reasonCopy({ code: 'executor_busy', outcome: 'fail', facts: {} }, labels)).toContain('an unknown number of');
});
test('headline and planner cost follow the outcome', () => {
  const chosen = { executor: 'codex', account: 'a', runner: 'codex', model: { kind: 'executor-default' as const }, host: null };
  expect(explainHeadline({ outcome: 'select', chosen }, labels)).toBe('Pacer would choose CODEX');
  expect(explainHeadline({ outcome: 'override', chosen }, labels)).toBe('CODEX, as you asked');
  expect(explainHeadline({ outcome: 'queue', chosen: null }, labels)).toBe('Pacer would hold this task until an executor can take it');
  // The runner, not the agent, names the choice, so two accounts of one agent stay distinct.
  expect(explainHeadline({ outcome: 'select', chosen: { ...chosen, runner: 'codex#team' } }, labels)).toBe('Pacer would choose CODEX#TEAM');
  expect(explainHeadline({ outcome: 'fail', chosen: null }, labels)).toBe('No executor can take this task now');
  expect(plannerCopy({ state: 'unknown', reason: 'too_few_samples' }, labels)).toContain('not enough similar reviewed tasks');
  expect(plannerCopy({ state: 'estimate', tokens: { median: 1200, p80: 3400 }, samples: 25, basis: 'kind', window: null }, labels)).toBe('Planner cost: about 1,200 tokens (80% of tasks under 3,400), from 25 similar tasks.');
});

test('host copy tolerates missing host facts and preserves named hosts', () => {
  for (const code of ['host_unreachable', 'host_reachability_unknown', 'host_paused', 'repo_not_on_host']) {
    for (const facts of [{}, { host: null }, { host: '' }, { host: 'build-box' }] as ReasonFacts[]) {
      const text = reasonCopy({ code, outcome: 'fail', facts }, labels);
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('null');
      if (facts.host) expect(text).toContain('build-box');
      else expect(text).toContain('host');
    }
  }
});
test('subject labels identify exclusions and uncertain runners', () => {
  for (const code of ['blocked_by_user', 'capacity_unmeasured', 'default_model_unresolved', 'added_later']) {
    const text = reasonCopy({ code, outcome: 'info', subject: 'codex#team', facts: {} }, labels, 'Codex · team');
    expect(text).toStartWith('Codex · team: ');
  }
  expect(reasonCopy({ code: 'blocked_by_user', outcome: 'fail', facts: {} }, labels, 'Codex · team')).toBe('Codex · team: You blocked it.');
});
test('queue reasons describe waiting and refused overrides name the requested runner', () => {
  const reason = { code: 'no_step_matched', outcome: 'fail' as const, facts: {} };
  expect(reasonCopy(reason, { ...labels, outcome: 'queue' })).toBe('No executor in the choice ladder is free right now.');
  expect(reasonCopy(reason, { ...labels, outcome: 'fail' })).toBe('No step in the choice ladder has an executor that can take it.');
  const chosen = { executor: 'claude-code', account: 'a', runner: 'claude-code', model: { kind: 'executor-default' as const }, host: null };
  // A refused request with a ladder pick leads with the pick; the refusal stays in the reasons.
  expect(explainHeadline({ outcome: 'select', chosen, reasons: [{ code: 'override_unavailable', outcome: 'fail', facts: { requested: 'codex#team' } }] }, labels)).toBe('Pacer would choose CLAUDE-CODE');
  expect(explainHeadline({ outcome: 'fail', chosen: null, reasons: [{ code: 'override_unavailable', outcome: 'fail', facts: { requested: 'codex#team' } }] }, labels)).toBe('CODEX#TEAM cannot take this task');
  expect(explainHeadline({ outcome: 'fail', chosen: null, reasons: [{ code: 'override', outcome: 'info', facts: { executor: 'codex#team' } }] }, labels)).toBe('CODEX#TEAM cannot take this task');
});
