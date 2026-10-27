import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { Stepper, CheckList } from '../app/src/ds/Stepper';
import { SettingsGeneral, AddExecutor } from '../app/src/screens/settings/index';
import { accountUsageWords } from '../app/src/screens/settings/Accounts';
import { AddHost, hostNameFrom, hostNameProblem, checkItems } from '../app/src/screens/settings/Machines';
import { AGENT_KINDS, agentStepProblem, blankAgentDraft, furthestAgentStep } from '../app/src/model/wizard';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { settings, executor, job } from './fixtures/ui/settings';

const api = { call: async () => ({}) } as any;
const withState = (snapshot: object) => ({ ...initialState(), connected: true, snapshot: { at: 1000, executors: [], accounts: [], hosts: [], repos: [], ...snapshot } as any });
const render = (child: any, s = withState({})) => renderToString(<TaskContext.Provider value={{ state: s, api }}>{child}</TaskContext.Provider>);
const facts = { installed: true as boolean | null, hosts: ['devbox'] };

test('stepper marks one current step, names done steps, and renders unreachable steps as plain text', () => {
  const html = renderToString(<Stepper label="Steps" onSelect={() => {}} steps={[
    { id: '1', title: 'Agent', state: 'done', reachable: true }, { id: '2', title: 'Account', state: 'current', reachable: true, detail: 'team' },
    { id: '3', title: 'Where', state: 'todo', reachable: false }]} />);
  expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  expect(html).toMatch(/<button[^>]*aria-current="step"[^>]*>[\s\S]*?Account/);
  expect(html).toContain('Agent<span class="sr-only">, done</span>');
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toMatch(/<span class="pc-stepper__step pc-stepper__step--todo">[\s\S]*?Where/);
});

test('check list states every result in words, not by glyph or colour alone', () => {
  const html = renderToString(<CheckList label="Checks" items={[{ id: 'a', label: 'ssh', state: 'passed' }, { id: 'b', label: 'git', state: 'failed', note: 'missing' }, { id: 'c', label: 'tail', state: 'skipped' }]} />);
  for (const word of ['Passed: ', 'Failed: ', 'Skipped: ']) expect(html).toContain(word);
  expect(html).toContain('missing');
  expect(checkItems({ ...job, steps: [{ name: 'checkout app', state: 'failed', detail: 'origin mismatch' }] })[0]).toMatchObject({ label: 'Checkout of app', state: 'failed', note: 'origin mismatch' });
});

test('wizard gating: each step needs its predecessors, and Next is withheld with a reason', () => {
  const draft = { ...blankAgentDraft };
  expect(agentStepProblem(1, draft, { ...facts, installed: false })).toContain('isn’t installed');
  expect(agentStepProblem(1, draft, { ...facts, installed: null })).toBeNull();
  // Codex needs an account; Antigravity and Cursor use their own sign-in.
  expect(agentStepProblem(2, draft, facts)).toBe('Choose or create an account.');
  expect(agentStepProblem(2, { ...draft, agent: 'agy' }, facts)).toBeNull();
  expect(agentStepProblem(3, { ...draft, agent: 'cursor', host: 'devbox' }, facts)).toContain('Only Codex and Claude Code');
  expect(agentStepProblem(3, { ...draft, host: 'gone' }, facts)).toBe('Choose a remote host.');
  for (const bad of ['0', '17', '1.5', '']) expect(agentStepProblem(3, { ...draft, maxTasks: bad }, facts)).toBe('Enter a whole number from 1 to 16.');
  expect(furthestAgentStep(draft, facts)).toBe(2);
  expect(furthestAgentStep({ ...draft, account: 'team' }, facts)).toBe(4);
  expect(furthestAgentStep({ ...draft, account: 'team', maxTasks: '0' }, facts)).toBe(3);
  expect(furthestAgentStep({ ...draft, createdId: 'codex#team' }, facts)).toBe(4);
  expect(AGENT_KINDS.map(([kind]) => kind)).toContain('tests');
});

test('wizard screen: a later step cannot be opened early, Continue is disabled with its reason, Ready waits for a passed test', () => {
  const early = render(<AddExecutor initialDraft={{ step: '4' }} />);
  // Asked for step 4 with no account: the wizard falls back to the furthest valid step.
  expect(early).toContain('Which account pays for it?');
  expect(early).toContain('Choose or create an account.');
  expect(early).toMatch(/<button[^>]*disabled[^>]*>Continue<\/button>/);
  expect((early.match(/<button[^>]*pc-stepper__step/g) ?? []).length).toBe(2);
  const last = (state: 'running' | 'failed' | 'passed') => render(<AddExecutor initialDraft={{ step: '4', account: 'team', createdId: executor.id, jobId: job.id }} />,
    { ...withState({}), jobs: { [job.id]: { ...job, state } } });
  expect(last('running')).toContain('Running test task');
  for (const state of ['running', 'failed'] as const) { expect(last(state)).not.toContain('is ready'); expect(last(state)).not.toContain('Open agents'); }
  expect(last('passed')).toContain(`${executor.id} is ready`);
  const stepsDone = (last('passed').match(/pc-stepper__step--done/g) ?? []).length;
  expect(stepsDone).toBe(4);
});

const accounts = [
  { name: 'team', kind: 'codex', signedIn: true, runners: [executor.id] },
  { name: 'out', kind: 'codex', signedIn: false, signin_command: 'codex login' },
  { name: 'ark', kind: 'endpoint', quotaSource: 'arkcli', state: 'not_tested', usageReading: { windows: [], error: 'x', availability: { state: 'unknown', reason: 'authentication_failed' } } },
  { name: 'stale', kind: 'codex', signedIn: true }, { name: 'bare', kind: 'codex' },
] as any;
const summary = (over: object) => ({ agent: 'codex', source: 'Codex sign-in', usedPct: 40, pacePct: 30, window: 'week', resetsAt: null, verdict: 'ON_PACE', signedIn: true, executors: [], spendUsdWeek: null, capUsdWeek: null, ...over });

test('Accounts: status pill with a fix link only where the fix can work', () => {
  const html = render(<SettingsGeneral section="accounts" initialData={{ ...settings, accounts }} />, withState({ accounts: [
    summary({ name: 'team', executors: [executor.id] }), summary({ name: 'stale', stale: true, capturedAt: 1, eligibility: { evaluatedAt: 1000, budget: 'unknown', reasons: [] } })] }));
  for (const label of ['Signed in', 'Signed out']) expect(html).toMatch(new RegExp(`pc-pill[^"]*"[^>]*>(?:<span[^>]*>[^<]*</span>)?${label}</span>`));
  // Sign-in help for the signed-out native account; Ark CLI help (with refresh) for its endpoint only: no other account has a refresh that can succeed.
  expect(html.match(/<summary>Fix sign-in<span class="sr-only"> for out<\/span><\/summary>/g)).toHaveLength(1);
  expect(html).toContain('<code>codex login</code>');
  expect(html).toContain('Fix Ark CLI sign-in');
  expect(html.match(/Refresh usage<span class="sr-only"> for ([a-z]+)/g)).toEqual(['Refresh usage<span class="sr-only"> for ark']);
  expect(html).not.toContain('Fix sign-in<span class="sr-only"> for team');
  expect(html).toContain('<a href="#/settings/accounts" aria-current="page"');
  expect(html).toContain('href="#/settings/executors"');
});

test('unknown data is omitted, never shown as zero or a measured value', () => {
  const html = render(<SettingsGeneral section="accounts" initialData={{ ...settings, accounts }} />, withState({ accounts: [summary({ name: 'team', usedPct: null, pacePct: null }), summary({ name: 'stale', usedPct: 0, pacePct: null })] }));
  // team: no reading at all -> no meter. stale: a real 0% reading is a measured fact and keeps its meter.
  expect(accountUsageWords(undefined)).toBe('Usage unknown');
  expect(accountUsageWords(summary({ usedPct: null }) as any)).toBe('No usage reported');
  expect(accountUsageWords(summary({ usedPct: 0 }) as any)).toBe('0% of week');
  expect((html.match(/role="meter"/g) ?? []).length).toBe(1);
  expect(html).not.toContain('0% of week · resets');
  const none = render(<SettingsGeneral section="executors" initialData={settings} />, withState({ executors: [{ ...executor, usedPct: null, pacePct: null }] }));
  expect(none).toContain('No usage reported');
  expect(none).not.toContain('role="meter"');
  expect(none).not.toMatch(/>0%</);
});

test('Agents: Add agent is the one primary action; the planner card and tabs come from the snapshot only', () => {
  const html = render(<SettingsGeneral section="executors" initialData={settings} />, withState({ executors: [executor], accounts: [summary({ name: 'team' })], planner: { agent: 'claude-code', runner: 'claude-code', advice: 'Keep planning' } }));
  expect((html.match(/pc-btn--primary/g) ?? []).length).toBe(2); // Add agent and the save bar's Save changes, which is disabled until there are edits.
  expect(html).toContain('Keep planning');
  expect(html).toContain('Executors · 1');
  expect(html).toContain('Accounts · 1');
  expect(html).toContain('href="#/settings/add-executor"');
  const bare = render(<SettingsGeneral section="executors" initialData={settings} />, withState({ planner: null }));
  expect(bare).not.toContain('Change planner');
});

test('host names: suggested from the alias, validated, and "local" is reserved', () => {
  expect(hostNameFrom('Dev_Box.lan')).toBe('dev-box-lan');
  expect(hostNameProblem('dev-1', ['taken'])).toBeNull();
  expect(hostNameProblem('Dev')).toContain('lower-case');
  expect(hostNameProblem('local')).toContain('reserved');
  expect(hostNameProblem('taken', ['taken'])).toContain('Another host');
});

test('Machines page offers the guided add and lists no hosts that pacer does not have', () => {
  const html = render(<SettingsGeneral section="machine" initialData={settings} />, withState({ machine: { used: 1, max: 4 }, executors: [{ ...executor, host: null }], hosts: [] }));
  for (const text of ['This machine', 'Add a remote host', 'Pick a host from your SSH config', 'Connect and check', 'Running 1 of 4']) expect(html).toContain(text);
  expect(html).not.toContain('Remote hosts');
  const noMachine = render(<SettingsGeneral section="machine" initialData={settings} />, withState({ hosts: [] }));
  expect(noMachine).not.toContain('Running ');
  expect(noMachine).not.toContain('Executors here');
});

test('Add remote host with no SSH aliases explains where they come from and offers no check that cannot work', () => {
  const html = render(<AddHost initialAliases={[]} />);
  expect(html).toContain('No new hosts in your SSH config');
  expect(html).not.toContain('Connect and check');
  expect(html).not.toContain('Pick a host from your SSH config first.');
});

test('wizard announces its step and offers Remove, not Cancel, once the agent exists but has not passed', () => {
  const draft = { step: '4', account: 'team', createdId: executor.id, jobId: job.id };
  const failed = render(<AddExecutor initialDraft={draft} />, { ...withState({}), jobs: { [job.id]: { ...job, state: 'failed' } } });
  expect(failed).toContain('aria-live="polite" class="sr-only">Step 4 of 4: Model and test');
  expect(failed).toContain('Remove this agent');
  expect(failed).not.toContain('>Cancel<');
  expect(render(<AddExecutor />)).toContain('>Cancel<');
  expect(render(<AddExecutor />)).not.toContain('Remove this agent');
});

test('route plumbing: Add agent receives the host link and host detail receives its alias through SettingsGeneral', () => {
  const state = withState({ hosts: [{ alias: 'devbox', ssh: 'devbox', state: 'ready', running: 0, maxTasks: 2, executors: [], repos: 0 }] });
  const add = render(<SettingsGeneral section="add-executor" host="devbox" initialData={settings} />, state);
  expect(add).toContain('Which agent?');
  const hostless = render(<SettingsGeneral section="add-executor" initialData={settings} />, state);
  expect(hostless).toContain('Which agent?');
  expect(render(<SettingsGeneral section="hosts" alias="devbox" initialData={settings} />, state)).toContain('Machines</a>');
  expect(render(<SettingsGeneral section="hosts" initialData={settings} />, state)).toContain('Add a remote host');
});
