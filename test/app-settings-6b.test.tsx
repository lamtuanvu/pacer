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
  expect(last('passed')).toContain("Codex · team on devbox is ready");
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
  for (const label of ['On pace', 'Signed out']) expect(html).toMatch(new RegExp(`pc-pill[^"]*"[^>]*>(?:<span[^>]*>[^<]*</span>)?${label}</span>`));
  // Sign-in help for the signed-out native account; Ark CLI help (with refresh) for its endpoint only: no other account has a refresh that can succeed.
  expect(html.match(/<summary>Fix sign-in<span class="sr-only"> for Codex · out<\/span><\/summary>/g)).toHaveLength(1);
  expect(html).toContain('Use the agent’s own sign-in to reconnect this account.');
  expect(html).not.toContain('<code>codex login</code>');
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
  expect((html.match(/pc-btn--primary/g) ?? []).length).toBe(1); // The idle save bar is absent.
  expect(html).toContain('Plans and reviews');
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

test('Agents: Executors and Accounts have a planner card; Accounts has the factual banner and sign-in column',()=>{
 const snapshot=withState({planner:{agent:'codex',runner:'codex',advice:'Planner advice'},accounts:[summary({name:'team',signedIn:false,source:'Observed source'})]});
 const executors=render(<SettingsGeneral section="executors" initialData={settings}/>,snapshot);
 expect(executors).toContain('aria-label="Planner"');
 expect(executors).not.toContain('>Connected<');
 expect(executors).not.toContain('class="u3-save-bar"');
 const html=render(<SettingsGeneral section="accounts" initialData={{...settings,accounts}}/>,snapshot);
 expect(html).toContain('aria-label="Planner"');
 expect(html).toContain('Change planner');
 expect(html).toContain('An account is where quota comes from.');
 expect(html).toContain('pacer never reads or copies an agent\'s own sign-in.');
 expect(html).toContain('Endpoint keys stay in your keychain and are used by reference.');
 expect(html).toContain('scope="col">Sign-in</th>');
 expect(html).toMatch(/data-label="Sign-in"><span>Signed out<\/span><div class="u3-muted">Codex’s own sign-in/);
 expect(html).toContain('data-label="Sign-in"><span>Unknown</span>');
});

test('Agents table shows count and known machine maximum, failing tint, and 24px identity',()=>{
 const html=render(<SettingsGeneral section="executors" initialData={settings}/>,withState({machine:{used:0,max:8},executors:[{...executor,state:'failing',slots:{used:0,max:3}}]}));
 expect(html).toContain('u3-row--bad');
 expect(html).toContain('data-label="Parallel"><strong>3</strong><span class="u3-muted"> of 8</span>');
 expect(html).toContain('--agent-size:24px');
 expect(html).not.toContain('type="number"');
 const unknown=render(<SettingsGeneral section="executors" initialData={settings}/>,withState({executors:[executor]}));
 expect(unknown).not.toContain(' of undefined');
});

test('Accounts policy uses the existing config values and shows the threshold only for fill',()=>{
 const policy=(mode:string)=>render(<SettingsGeneral section="accounts" initialData={{...settings,accounts,config:{keys:{'pacing.accounts':{value:mode},'pacing.fill_threshold':{value:85}},planners:[]}}}/>);
 expect(policy('spread')).toContain('role="group" aria-label="Multiple accounts"');
 expect(policy('spread')).toContain('Spread evenly');
 expect(policy('spread')).not.toContain('Account fill threshold');
 expect(policy('fill')).toContain('aria-label="Account fill threshold"');
 expect(policy('fill')).toContain('value="85"');
});

test('Accounts policy explains disconnected controls',()=>{
 const html=render(<SettingsGeneral section="accounts" initialData={{...settings,accounts,config:{keys:{'pacing.accounts':{value:'spread'}},planners:[]}}}/>,{...withState({}),connected:false});
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
