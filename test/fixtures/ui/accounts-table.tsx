import { render } from 'preact';
import { AccountsSection } from '../../../app/src/screens/settings/Accounts';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { SettingsPageContext } from '../../../app/src/screens/settings/shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { NotificationProvider } from '../../../app/src/data/notification-context';
import { initialState } from '../../../app/src/data/store';

const accounts = [
  { name: 'team', kind: 'codex', signedIn: true, runners: ['codex#team'] },
  { name: 'out', kind: 'codex', signedIn: false, signin_command: 'codex login' },
  { name: 'ark', kind: 'endpoint', quotaSource: 'arkcli', state: 'not_tested', usageReading: { windows: [], availability: { state: 'unknown', reason: 'authentication_failed' } } },
] as any;
const config = { keys: {}, planners: [] };
const calls: [string, any][] = [];
Object.assign(window, { accountFixture: { calls: () => calls } });
const api = { call: async (op: string, params: any) => {
  calls.push([op, params]);
  if (op === 'account.list') return accounts;
  if (op === 'config.get') return config;
  if (op === 'limits.refresh') return { accounts: [{ account: 'ark', outcome: 'ok' }] };
  return {};
} } as any;
const actions = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const state = { ...initialState(), connected: true, snapshot: { at: 1, executors: [], accounts: [{ name: 'team', agent: 'codex', signedIn: true, usedPct: 40, pacePct: 30, window: 'week', verdict: 'ON_PACE', executors: ['codex#team'] }], hosts: [], repos: [] } } as any;
render(<NotificationProvider><TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={actions}><SettingsPageContext.Provider value="accounts"><div className="u3-settings"><AccountsSection initialData={accounts} initialConfig={config} /></div></SettingsPageContext.Provider></ActionContext.Provider></TaskContext.Provider></NotificationProvider>, document.getElementById('app')!);
