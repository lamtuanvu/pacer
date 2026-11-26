import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { attachKeyRegistry, createKeyRegistry } from '../../../app/src/keys/registry';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { NotificationProvider } from '../../../app/src/data/notification-context';
import { canLeaveScreen } from '../../../app/src/data/navigation-guard';
import { initialState } from '../../../app/src/data/store';
import { ApiError } from '../../../app/src/data/api';
import type { ExecutorSettings } from '../../../app/src/model/executor-settings';
import type { RunnerModels } from '../../../src/core/runner-models';
import { AgentsPage } from './agents';

// Dispatcher › Agents against an in-memory service: one strategy revision shared by limits and models.
const shellKeys = createKeyRegistry({ controlActive: () => false, blocked: () => !!document.querySelector('dialog[open]') });
let shellEscapes = 0;
shellKeys.setScope('settings');
shellKeys.register({ keys: 'Escape', label: 'Close settings', scope: 'settings', run: () => { shellEscapes++; } });
attachKeyRegistry(shellKeys, window);

let revision = 1;
let settings: ExecutorSettings = { revision: '1', order: ['codex', 'opencode#tse'], runners: [{ id: 'codex', enabled: true, maxTasks: 1 }, { id: 'opencode#tse', enabled: true, maxTasks: 1 }] };
const models: Record<string, RunnerModels> = {
  'claude-code': { runner: 'claude-code', revision: '1', default: 'opus', models: [{ id: 'opus', tier: 'frontier' }] },
  codex: { runner: 'codex', revision: '1', default: null, models: [] },
  'opencode#tse': { runner: 'opencode#tse', revision: '1', default: 'terastor-ai', models: [{ id: 'terastor-ai', tier: 'medium' }] },
};
const listing = { runner: 'opencode#tse', source: 'opencode', fetchedAt: 1800000000, provider: 'tse', models: [{ id: 'terastor-ai', context: 128000, tools: true, costOut: 2 }, { id: 'terastor-ai-pro', context: 1000000, tools: true, costOut: 12 }] };
let writes = 0, modelWrites = 0, fail = false, hold = false, conflictNext = false, failing = false;
let release = () => {};
let refresh = () => {};
const calls: [string, unknown][] = [];
const moveRevision = () => { revision++; settings = { ...settings, revision: String(revision) }; for (const m of Object.values(models)) m.revision = String(revision); };
const fixture = {
  calls: () => calls, writes: () => writes, modelWrites: () => modelWrites, settings: () => settings, models: () => models, shellEscapes: () => shellEscapes,
  fail: (value: boolean) => { fail = value; }, holdSave: () => { hold = true; }, release: () => { hold = false; release(); },
  conflictNext: () => { conflictNext = true; }, failing: (value: boolean) => { failing = value; refresh(); },
  external: () => { moveRevision(); refresh(); },
  setLimit: (maxTasks: number) => { moveRevision(); settings = { ...settings, runners: settings.runners.map(r => r.id === 'codex' ? { ...r, maxTasks } : r) }; refresh(); },
  leave: (target?: string) => canLeaveScreen(target), refresh: () => refresh(),
};
Object.assign(window, { agentsFixture: fixture });
const api = { call: async (op: string, p: any) => {
  calls.push([op, p]);
  if (op === 'runner.settings.get') return structuredClone(settings);
  if (op === 'runner.models.get') return structuredClone(models[p.id] ?? { runner: p.id, revision: String(revision), default: null, models: [] });
  if (op === 'executor.models.available') return p.runner === 'opencode#tse' ? listing : { runner: p.runner, source: 'none', models: null, fetchedAt: 1800000000 };
  if (op === 'account.list') return [{ name: 'claude-code', kind: 'claude', signedIn: true }, { name: 'codex', kind: 'codex', signedIn: true }, { name: 'tse', kind: 'endpoint', state: 'ready' }];
  if (op === 'config.get') return { keys: { 'pacing.planner_tier_fallback': { value: 'on' } }, planners: [] };
  if (op === 'dispatch.config.get') return { planner: 'claude-code', plannerAccount: 'claude-code', config: { tierTargets: { simple: 'small', standard: 'medium', complex: 'frontier' } } };
  if (op === 'job.list') return [];
  if (op === 'runner.remove') { if (fail) throw new Error('Service unavailable'); settings = { ...settings, order: settings.order.filter(id => id !== p.id), runners: settings.runners.filter(r => r.id !== p.id) }; moveRevision(); refresh(); return {}; }
  if (op === 'runner.models.set_many') {
    if (fail) throw new Error('Service unavailable');
    if (p.expectedRevision !== String(revision)) throw new ApiError('conflict', 'Executor settings changed elsewhere.');
    modelWrites++; moveRevision();
    for (const runner of p.runners) models[runner.id] = { runner: runner.id, revision: String(revision), default: runner.default, models: runner.models };
    return { revision: String(revision), runners: p.runners.map((r: { id: string }) => models[r.id]), warnings: [] };
  }
  if (op === 'runner.settings.save') {
    writes++;
    if (fail) { if (hold) await new Promise<void>(resolve => { release = resolve; }); throw new Error('Service unavailable'); }
    if (conflictNext) { conflictNext = false; moveRevision(); throw new ApiError('conflict', 'Settings changed elsewhere'); }
    if (p.expectedRevision !== settings.revision) throw new ApiError('conflict', 'Settings changed elsewhere');
    moveRevision();
    settings = { revision: String(revision), order: p.order, runners: p.runners };
    const result = { ...structuredClone(settings), warnings: [] };
    refresh();
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    return result;
  }
  return {};
} } as any;
const actions = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const agentFromHash = () => new URLSearchParams(location.hash.split('?')[1] ?? '').get('agent') ?? undefined;
function App() {
  const [tick, setTick] = useState(0), [agent, setAgent] = useState(agentFromHash());
  refresh = () => setTick(t => t + 1);
  // The router passes ?agent= to the tab; selecting an agent keeps the page (and its draft) mounted.
  useEffect(() => { const sync = async () => { if (await canLeaveScreen(location.hash)) setAgent(agentFromHash()); }; addEventListener('hashchange', sync); return () => removeEventListener('hashchange', sync); }, []);
  const row = (id: string, rank: number | 'planner') => ({ id, agent: id.split('#')[0], account: id.split('#')[1] ?? id, host: null, model: null, rank, enabled: settings.runners.find(r => r.id === id)?.enabled ?? true,
    state: failing && id === 'codex' ? 'failing' : 'ready', reason: failing && id === 'codex' ? 'Endpoint returned 402' : undefined, tone: failing && id === 'codex' ? 'bad' : 'good', sub: '', usedPct: null, pacePct: null, slots: { used: 0, max: 1 }, lastCheck: null, recentFailures: 0, next: false });
  const executors = [row('claude-code', 'planner'), ...settings.order.map((id, i) => row(id, i + 1))];
  const state = { ...initialState(), connected: true, invalidations: { runners: tick }, features: { ...initialState().features, ops: new Set(['limits.refresh']) },
    snapshot: { at: 1800000000, executors, accounts: [], hosts: [], repos: [], planner: { agent: 'claude-code', runner: 'claude-code' } } } as any;
  return <TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={actions}><AgentsPage agent={agent} /></ActionContext.Provider></TaskContext.Provider>;
}
render(<NotificationProvider><App /></NotificationProvider>, document.getElementById('app')!);
