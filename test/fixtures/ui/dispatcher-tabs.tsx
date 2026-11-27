import { render } from 'preact';
import { DensityContext } from '../../../app/src/ds/Density';
import { initialState } from '../../../app/src/data/store';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { DispatcherSection } from '../../../app/src/screens/settings/Dispatcher';
import { DispatcherHead, type DispatcherTab } from '../../../app/src/screens/settings/DispatcherTabs';
import { SettingsPageContext, SettingsQueryContext } from '../../../app/src/screens/settings/shared';
import { dispatchConfigSchema } from '../../../src/dispatch/types';

// Dispatcher › Overview, Who can run what and Profiles against an in-memory service, mounted the way
// SettingsGeneral mounts them (page head plus the tab), without the lazy chunk boundary.
const tab = (location.hash.slice(1) || 'dispatcher') as DispatcherTab;
const config = dispatchConfigSchema.parse({});
const view = { strategy: 'default', planner: 'claude-code', plannerAccount: 'claude-code', source: 'strategy', config };
const eligible = { state: 'eligible', reasons: [], evaluatedAt: 1800000000, validUntil: null, evidenceAgeS: 0, availability: 'available', budget: 'within', spendingRisk: 'low' };
const row = (id: string, rank: number | 'planner', over: Record<string, unknown> = {}) => ({
  id, agent: id.split('#')[0], account: id.split('#')[1] ?? id, host: null, model: null, rank, enabled: true, state: 'ready', tone: 'good', sub: '',
  usedPct: null, pacePct: null, slots: { used: 0, max: 1 }, lastCheck: null, recentFailures: 0, next: false, eligibility: eligible, ...over,
});
const executors = [
  row('claude-code', 'planner'),
  row('codex', 1, { state: 'exhausted', eligibility: { ...eligible, state: 'ineligible', reasons: [{ code: 'budget_exhausted', evidenceIds: [] }] } }),
  row('opencode#byteplus', 2, { enabled: false, state: 'disabled' }),
  row('opencode#local', 3),
  row('opencode#tse', 4),
  row('opencode#oc-go-free', 5),
];
const record = (runner: string, id: string | null, tier: string) => ({ runner, account: runner.split('#')[1] ?? runner, executor: runner.split('#')[0], binding: id ? { kind: 'exact', id } : { kind: 'executor-default' }, actualModel: null, tier, strengths: [], provenance: 'declared' });
const models = [
  record('claude-code', 'opus', 'frontier'), record('opencode#tse', 'terastor-ai', 'medium'),
  record('opencode#oc-go-free', 'iceman-contributor-free', 'small'), record('opencode#oc-go-free', 'hy4-flash-free', 'medium'),
  record('opencode#local', 'qwen3.6-35b-a3b', 'unknown'), record('opencode#byteplus', 'dola-seed-2.0-code', 'unknown'), record('codex', null, 'unknown'),
];
const repo = { key: 'github.com/acme/pacer', label: 'github.com/acme/pacer', path: '/work/pacer' };
const project = { repo, rev: 3, executors: ['codex', 'opencode#tse'], available: executors.slice(1).map(item => ({ id: item.id, reference: item.id, label: item.id })) };
const profiles = [
  { name: 'default', active: true, summary: 'Codex first, Claude Code keeps 15%' },
  { name: 'cheap-first', active: false, summary: 'Local model first, Claude Code keeps 15%; cheapest-first policy', description: 'Routine bulk work: local model and BytePlus before the subscriptions.' },
  { name: 'save-claude', active: false, summary: 'Codex first, Claude Code keeps 30%' },
];
const yaml = (policy: string, reserve: number) => `planner: claude-code\npacing: \n  policy: ${policy}\n  planner_reserve: ${reserve}\nrouting: \n  - executors: \n      - codex\n`;
let routing = { rules: [{ executors: ['codex', 'opencode#byteplus', 'opencode#local'] }], available: executors.map(item => item.id) };
const calls: [string, any][] = [];
Object.assign(window, { hubFixture: { calls: () => calls, routing: () => routing } });
const api = { call: async (op: string, params: any) => {
  calls.push([op, params]);
  switch (op) {
    case 'dispatch.config.get': return view;
    case 'dispatch.models': return { models, advertised: [], observedAt: 1800000000 };
    case 'config.get': return { keys: { 'pacing.planner_tier_fallback': { value: 'on' } }, planners: [] };
    case 'runner.models.get': return { runner: params.id, revision: '1', default: params.id === 'codex' ? 'gpt-5.5' : null, models: [] };
    case 'routing.get': return structuredClone(routing);
    case 'routing.set': routing = { ...routing, rules: params.rules }; return {};
    case 'project.strategy.list': return [project];
    case 'project.strategy.get': return project;
    case 'strategy.list': return profiles;
    case 'strategy.preview': {
      const from = params.draft.from;
      const cheap = from === 'cheap-first';
      return { ok: true, errors: [], summary: '', yaml: from === 'save-claude' ? yaml('priority', 30) : cheap ? yaml('cheapest-first', 15) : yaml('priority', 15),
        ranking: { current: ['codex', 'opencode#local'], draft: cheap ? ['opencode#local', 'opencode#byteplus', 'codex'] : ['codex', 'opencode#local'] },
        routing: { current: routing.rules, draft: cheap ? [{ executors: ['opencode#local', 'opencode#byteplus', 'codex'] }] : routing.rules } };
    }
    case 'dispatch.explain': return { schemaVersion: 1, revision: 'r1', at: 0, observedAt: null, outcome: 'select', kind: { value: 'tests', source: 'given' },
      strategy: { name: 'cheap-first', draft: !!params.strategyDraft, source: 'strategy' }, engine: { id: 'ladder', version: '1' },
      chosen: { executor: 'opencode', account: 'local', runner: 'opencode#local', model: { kind: 'executor-default' }, host: null }, step: { id: 'usable-fallback', index: 1, skipped: [] },
      reasons: [], fallbacks: [], planner: { state: 'unknown', reason: 'planner_not_measured' }, uncertainty: [] };
    default: return {};
  }
} } as any;
const ops = ['dispatch.config.get', 'dispatch.models', 'dispatch.explain', 'dispatch.tierTargets.set', 'routing.get', 'routing.set', 'strategy.list', 'strategy.preview', 'strategy.use', 'strategy.save',
  'project.strategy.get', 'project.strategy.list', 'project.strategy.set', 'project.strategy.remove', 'limits.refresh'];
const state = { ...initialState(), connected: true, features: { readModel: true, ops: new Set(ops) },
  snapshot: { ...initialState().snapshot, at: 1800000000, executors, accounts: [], hosts: [], repos: [repo], tasks: [], planner: { agent: 'claude-code', runner: 'claude-code' } } } as any;
const actions = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const section = tab === 'rules' ? 'rules' : tab === 'profiles' ? 'profiles' : 'overview';
render(<TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={actions}><DensityContext.Provider value="settings"><SettingsPageContext.Provider value="dispatcher"><SettingsQueryContext.Provider value={{ repo: null, scope: null }}>
  <main className="u3-settings u3-settings-page">
    <DispatcherHead current={tab} />
    <div className="u3-general-sections"><DispatcherSection query={{ repo: null, scope: null }} tab={section} /></div>
  </main>
</SettingsQueryContext.Provider></SettingsPageContext.Provider></DensityContext.Provider></ActionContext.Provider></TaskContext.Provider>, document.getElementById('app')!);
