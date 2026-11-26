import { expect, test } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import { Stepper, CheckList } from '../app/src/ds/Stepper';
import { SettingsGeneral, AddExecutor } from '../app/src/screens/settings/index';
import { usageView } from '../src/view-model/usage';
import { usageStateFor } from './usage-fixtures';
import { AddHost, hostNameFrom, hostNameProblem, checkItems } from '../app/src/screens/settings/Machines';
import { AGENT_KINDS, agentStepProblem, blankAgentDraft, furthestAgentStep } from '../app/src/model/wizard';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { settings, executor, job } from './fixtures/ui/settings';
import { renderAgents } from './fixtures/ui/agents';

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
  expect(last('passed')).toContain("Codex · team on devbox is ready");
  const stepsDone = (last('passed').match(/pc-stepper__step--done/g) ?? []).length;
  expect(stepsDone).toBe(4);
});

const accounts = [
  { name: 'team', kind: 'codex', signedIn: true, runners: [executor.id] },
  { name: 'out', kind: 'codex', signedIn: false, signin_command: 'codex login' },
  { name: 'ark', kind: 'endpoint', quotaSource: 'arkcli', state: 'not_tested', usageCheck: { action: 'refresh', consentRequired: false, description: 'Read provider usage' }, diagnostics: { readings: [{ windows: [], error: 'x', availability: { state: 'unknown', reason: 'authentication_failed' } }] } },
  { name: 'stale', kind: 'codex', signedIn: true }, { name: 'bare', kind: 'codex' },
] as any;
const summary = (over: object) => {
  const base = { agent: 'codex', source: 'Codex sign-in', usedPct: 40, pacePct: 30, window: 'week', resetsAt: null, verdict: 'ON_PACE', signedIn: true, executors: [], spendUsdWeek: null, capUsdWeek: null, ...over };
  // The snapshot row carries the one usage record derived from its own fields (ADR 0030).
  return { ...base, usageState: usageStateFor(base, 1000) };
};

test('Agents: account status pill with a fix only where the fix can work', () => {
  const row = (id: string, account: string, agent = 'codex') => ({ ...executor, id, agent, account, host: null });
  const rows = [executor, row('codex#out', 'out'), row('opencode#ark', 'ark', 'opencode'), row('codex#stale', 'stale')];
  const s = withState({ executors: rows, accounts: [
    summary({ name: 'team', executors: [executor.id], stale: false, capturedAt: 1000 }), summary({ name: 'stale', stale: true, capturedAt: 1, eligibility: { evaluatedAt: 1000, budget: 'unknown', reasons: [] } })] });
  const page = (agent: string) => renderAgents(s, { agent, initialAccounts: accounts });
  const pill = (label: string) => new RegExp(`pc-pill[^"]*"[^>]*>(?:<span[^>]*>[^<]*</span>)?${label}</span>`);
  expect(page(executor.id)).toMatch(pill('On pace'));
  expect(page('codex#out')).toMatch(pill('Signed out'));
  // Sign-in help remains available for the signed-out native account and Ark CLI endpoint.
  expect(page('codex#out').match(/<summary>Fix sign-in<span class="sr-only"> for Codex · out<\/span><\/summary>/g)).toHaveLength(1);
  expect(page('codex#out')).toContain('Use the agent’s own sign-in to reconnect this account.');
  expect(page('codex#out')).not.toContain('<code>codex login</code>');
  expect(page('opencode#ark')).toContain('Fix Ark CLI sign-in');
  // Only accounts with a usage capability offer Check usage; the others say how to get the controls back.
  expect(page('opencode#ark').match(/Check usage<span class="sr-only"> for [^<]+<\/span>/g)).toEqual(['Check usage<span class="sr-only"> for ark</span>']);
  for (const agent of [executor.id, 'codex#out', 'codex#stale']) expect(page(agent)).toContain('Reconnect to load account usage controls.');
  expect(page(executor.id)).not.toContain('Fix sign-in<span class="sr-only"> for');
  // The Dispatcher tabs and the agent list both link with aria-current on the open entry only.
  expect(page('codex#out')).toContain('<a href="#/settings/agents?agent=codex%23out" aria-current="page"');
  expect(page('codex#out').match(/aria-current="page"/g)).toHaveLength(1);
});

test('unknown data is omitted, never shown as zero or a measured value', () => {
  // team: no reading at all -> no meter. stale: a real 0% reading is a measured fact and keeps its meter.
  expect(usageView(undefined, 1000).figure).toBe('Usage unknown');
  expect(usageView(usageStateFor({ usedPct: null }, 1000), 1000).figure).toBe('No usage figure');
  expect(usageView(usageStateFor({ usedPct: 0, window: 'week' }, 1000), 1000).figure).toBe('0%');
  const zero = renderAgents(withState({ executors: [{ ...executor, account: 'stale' }], accounts: [summary({ name: 'stale', usedPct: 0, pacePct: null })] }), { initialAccounts: accounts });
  expect((zero.match(/role="meter"/g) ?? []).length).toBe(1);
  expect(zero).toContain('0% of week');
  const none = renderAgents(withState({ executors: [{ ...executor, usedPct: null, pacePct: null }] }));
  expect(none).toContain('Usage unknown');
  expect(none).not.toContain('role="meter"');
  expect(none).not.toMatch(/>0%</);
});

test('Agents: no primary action while idle; the planner leads the list and offers Change planner', () => {
  const planner = { ...executor, id: 'claude-code', agent: 'claude-code', account: 'claude-code', host: null, rank: 'planner' as const };
  const html = renderAgents(withState({ executors: [planner, executor], accounts: [summary({ name: 'team' })], planner: { agent: 'claude-code', runner: 'claude-code', advice: 'Keep planning' } }));
  expect((html.match(/pc-btn--primary/g) ?? []).length).toBe(0); // The idle save bar has no actions.
  expect(html).toContain('href="#/settings/add-executor"');
  expect(html.indexOf('>Planner</span>')).toBeLessThan(html.indexOf('>Executors</span>'));
  // The planner is selected first, marked as planner, and changed from Budget & pacing, never removed here.
  expect(html).toContain('<a href="#/settings/agents?agent=claude-code" aria-current="page"');
  expect(html).toContain('href="#/settings/planner"');
  expect(html).toContain('Change planner');
  expect(html).not.toContain('Remove Claude Code');
  const executorPage = renderAgents(withState({ executors: [planner, executor] }), { agent: executor.id });
  expect(executorPage).not.toContain('Change planner');
  expect(executorPage).toContain('Remove Codex · team on devbox');
  expect(executorPage).toContain('Removing keeps its task history.');
  const bare = renderAgents(withState({ executors: [executor], planner: null }));
  expect(bare).not.toContain('Change planner');
  expect(bare).not.toContain('>Planner</span>');
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
  for (const text of ['This Mac', 'Add a remote host', 'Pick a host from your SSH config', 'Connect and check', 'Running 1 of 4']) expect(html).toContain(text);
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

test('Agents: the planner tier fallback card binds the existing config key; executors have none', () => {
  const planner = { ...executor, id: 'claude-code', agent: 'claude-code', account: 'claude-code', host: null, rank: 'planner' as const };
  const config = (value?: string) => ({ keys: { ...(value ? { 'pacing.planner_tier_fallback': { value } } : {}) }, planners: [] }) as any;
  const page = (value?: string, agent?: string) => renderAgents(withState({ executors: [planner, executor] }), { agent, initialConfig: config(value) });
  expect(page('on')).toContain('Take complex tasks when no executor can');
  expect(page('on')).toMatch(/<input[^>]*aria-labelledby="planner-fallback-label"[^>]*checked/);
  expect(page('on')).toContain('Right now that is the case.');
  expect(page('off')).toContain('Off: Pacer sends the planner no delegated tasks.');
  // An older service without the key gets no switch that cannot work (UI-13).
  expect(page()).not.toContain('Take complex tasks when no executor can');
  expect(page('on', executor.id)).not.toContain('Take complex tasks when no executor can');
});

test('Agents show the parallel limit with the known machine maximum, the agent mark and readiness tone', () => {
  const html = renderAgents(withState({ machine: { used: 0, max: 8 }, executors: [{ ...executor, state: 'failing', slots: { used: 0, max: 3 } }] }));
  expect(html).toContain('Up to 3 tasks at once · machine limit 8');
  expect(html).toContain('--agent-size:24px'); // list entry
  expect(html).toContain('--agent-size:40px'); // detail header
  const unknown = renderAgents(withState({ executors: [executor] }));
  expect(unknown).not.toContain('machine limit');
  expect(unknown).not.toContain(' of undefined');
});

test('Account policy appears for an agent with several accounts, uses the existing config values and shows the threshold only for fill', () => {
  const policy = (mode: string, list = accounts) => renderAgents(withState({ executors: [executor] }), { initialAccounts: list, initialConfig: { keys: { 'pacing.accounts': { value: mode }, 'pacing.fill_threshold': { value: 85 } }, planners: [] } as any });
  expect(policy('spread')).toContain('role="group" aria-label="Multiple accounts"');
  expect(policy('spread')).toContain('Spread evenly');
  expect(policy('spread')).not.toContain('Account fill threshold');
  expect(policy('fill')).toContain('aria-label="Account fill threshold"');
  expect(policy('fill')).toContain('value="85"');
  // One account: no policy to choose.
  expect(policy('spread', [accounts[0]])).not.toContain('Multiple accounts');
});

test('Account policy explains disconnected controls', () => {
  const html = renderAgents({ ...withState({ executors: [executor] }), connected: false }, { initialAccounts: accounts, initialConfig: { keys: { 'pacing.accounts': { value: 'spread' } }, planners: [] } as any });
  expect(html).toContain('Reconnecting. Account policy changes will be available when the service reconnects.');
  expect(html).toMatch(/<button[^>]*disabled/);
});

test('Machines uses the board cards and only reports known local facts and executor caps', () => {
  const html = render(<SettingsGeneral section="machine" initialData={settings} />, withState({
    service: {version:'0.11.0'}, machine: {used:1,max:4}, executors: [{...executor,host:null,slots:{used:1,max:3}}],
  }));
  expect(html.match(/class="u3-machine-card"/g)).toHaveLength(2);
  expect(html).toContain('pacer 0.11.0');
  expect(html).toContain('pc-pill--good');
  expect(html).toContain('may use 3');
  // The default is no limit; the number field appears only for a hard cap.
  expect(html).toContain('aria-label="Parallel tasks"');
  expect(render(<SettingsGeneral section="machine" initialData={{...settings,config:{...settings.config!,keys:{...settings.config!.keys,'execution.local_max_tasks':{value:4}}}}} />, withState({}))).toContain('u3-parallel-input');
  expect(html).toContain('~/.pacer/worktrees');
  expect(html).toContain('u3-terminal-picker');
  for (const absent of ['macOS 27','arm64']) expect(html).not.toContain(absent);
  const empty=render(<SettingsGeneral section="machine" initialData={settings}/>,withState({machine:{used:0,max:4}}));
  expect(empty).toMatch(/pc-pill--neutral[^>]*>Running 0 of 4/);
  expect(empty).toContain('Every executor may use the machine limit.');
  const atLimit = render(<SettingsGeneral section="machine" initialData={settings}/>,withState({machine:{used:0,max:4,hardCap:4,unlimited:false},executors:[{...executor,host:null,slots:{used:0,max:4}}]}));
  expect(atLimit).not.toContain('may use 4');
  const uncapped = render(<SettingsGeneral section="machine" initialData={settings}/>,withState({machine:{used:0,max:Number.MAX_SAFE_INTEGER,hardCap:null,unlimited:true}}));
  expect(uncapped).toContain('No fixed machine limit; new tasks wait under memory pressure or over the load limit.');
  expect(uncapped).not.toContain(String(Number.MAX_SAFE_INTEGER));
});

test('Add host offers aliases without invented HostName captions and waits for a passed check', () => {
  const html=render(<AddHost initialAliases={['devbox','pi-lab']}/>);
  expect(html).toContain('pc-choice-card--alias');
  expect(html).toContain('<code>devbox</code>');
  expect(html).not.toContain('34.80');
  expect(html).not.toContain('Next, map the repositories');
  expect(html).not.toContain('pc-check-list');
  expect(html).toContain('u3-host-name');
  expect(html).toContain('Pick a host from your SSH config first.');
});

test('Add agent has a breadcrumb, polite panel, found state, selection check and actual install guidance', () => {
  const html=render(<AddExecutor initialDetection={[
    {agent:'codex',found:true,version:'1.0',path:'',install_hint:''},
    {agent:'cursor',found:false,version:null,path:'',install_hint:'install-cursor'},
  ]}/>);
  expect(html).toContain('aria-label="Breadcrumb"');
  expect(html).toContain('aria-labelledby="agent-step-heading" class="u3-wizard-panel"');
  // The step is announced once, by the status line; the panel itself is not a live region.
  expect(html).not.toContain('aria-live="polite" aria-labelledby="agent-step-heading"');
  expect(html).toContain('u3-selected-check');
  expect(html).toContain('--agent-size:28px');
  expect(html).toContain('Not installed · how to install');
  expect(html).toContain('Install: <code>install-cursor</code>');
  expect(html).toContain("Agents that aren't installed show how to get them.");
  expect(render(<AddExecutor initialDetection={[]}/>)).toContain('show how to get them');
});

test('Add agent account and location options use radios and omit unavailable remote choices', () => {
  const account=render(<AddExecutor initialDraft={{step:'2'}} initialAccounts={accounts}/>);
  expect(account).toContain('pc-radio-choices--options');
  expect(account).toContain('type="radio"');
  expect(account).not.toContain('Use an Orca account');
  const where=render(<AddExecutor initialDraft={{step:'3',account:'team'}}/>);
  expect(where).toContain('name="agent-location"');
  expect(where).toContain('Add one in Machines');
  expect(where).not.toContain('value="remote"');
  expect(where).not.toContain('16 parallel tasks shared');
});

test('Add agent model picker uses only reported models and nests test status and checks in its test block', () => {
  const html=render(<AddExecutor initialDraft={{step:'4',account:'team'}} initialAccounts={[
    {name:'team',kind:'codex',connection:{models:[{id:'fixture-model'}]}},
  ]}/>);
  expect(html).toContain('u3-model-picker');
  expect(html).toContain('Agent default');
  expect(html).not.toContain('gemini-3-pro');
  expect(html).toContain('class="u3-test-task"');
  expect(html).toContain('Not tested yet');
  expect(html.match(/>Add agent and run test task</g)).toHaveLength(1);
  const running=render(<AddExecutor initialDraft={{step:'4',account:'team',createdId:executor.id,jobId:job.id}}/>,{...withState({}),jobs:{[job.id]:{...job,state:'running'}}});
  expect(running).toContain('pc-check-list--unboxed');
  expect(running).toContain('Your draft is kept if you leave');
});

test('Machines renders the measured local OS and architecture when the service reports them', () => {
  const html = render(<SettingsGeneral section="machine" initialData={settings}/>,withState({service:{version:'0.11.0'},machine:{used:0,max:4,os:'macOS 27.0',arch:'arm64'}}));
  expect(html).toContain('macOS 27.0 · arm64 · pacer 0.11.0');
});
