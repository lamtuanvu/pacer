import { render } from 'preact';
import { AddExecutor } from '../../../app/src/screens/settings/AddExecutor';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { NotificationProvider } from '../../../app/src/data/notification-context';
import { initialState } from '../../../app/src/data/store';

const calls: [string, any][] = [];
let outcome = 'passed', installed = false;
let releaseDetection = () => {}; let holdDetection = false;
Object.assign(window, { agentFixture: { calls: () => calls, install: () => { installed = true; }, holdDetection: () => { holdDetection = true; }, releaseDetection: () => releaseDetection(), outcome: (value: string) => { outcome = value; } } });
const api = { call: async (op: string, params: any) => {
  calls.push([op, params]);
  if (op === 'account.list') return [{ name: 'team', kind: 'codex', signedIn: true, connection: { models: [{ id: 'fixture-model', name: 'Fixture model' }] } }];
  if (op === 'agent.detect') { if (holdDetection) await new Promise<void>(resolve => { releaseDetection = resolve; }); return [{ agent: 'codex', found: true, version: '1.0', path: '/x', install_hint: '' }, { agent: 'cursor', found: installed, install_hint: 'install-cursor' }]; }
  if (op === 'runner.add') { await new Promise(resolve => setTimeout(resolve, 150)); return { id: 'codex#team', job: { id: 'j1', kind: 'runner.check', target: 'codex#team', state: 'running', steps: [{ name: 'Test task', state: 'running' }], startedAt: 1 } }; }
  if (op === 'job.get') return { id: 'j1', kind: 'runner.check', target: 'codex#team', state: outcome, steps: [{ name: 'Test task', state: outcome === 'passed' ? 'passed' : 'failed', detail: outcome === 'passed' ? '' : 'Not logged in' }], startedAt: 1, endedAt: 2 };
  return {};
} } as any;
const actions = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const state = { ...initialState(), connected: true, snapshot: { at: 1, executors: [], accounts: [], hosts: [{ alias: 'devbox', ssh: 'devbox', state: 'ready', running: 0, maxTasks: 2, executors: [], repos: 0 }], repos: [] } } as any;
render(<NotificationProvider><TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={actions}><AddExecutor host="devbox" /></ActionContext.Provider></TaskContext.Provider></NotificationProvider>, document.getElementById('app')!);
