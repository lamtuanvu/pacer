import { render } from 'preact';
import { useState } from 'preact/hooks';
import { SortableList } from '../../../app/src/ds/SortableList';
import { SaveBar } from '../../../app/src/ds/SaveBar';
import { orderChanges } from '../../../app/src/model/dispatcher-setup';
import { SetupEditor } from '../../../app/src/screens/settings/DispatcherSetup';
import { DispatcherPreviewForm } from '../../../app/src/screens/settings/Dispatcher';
import type { StrategyDraft } from '../../../app/src/model/dispatcher-setup';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { initialState } from '../../../app/src/data/store';
import { dispatchConfigSchema } from '../../../src/dispatch/types';
import type { Rule } from '../../../app/src/model/executors';

const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', cursor: 'Cursor' };
const saved = ['codex', 'claude', 'opencode', 'cursor'];

function Fixture() {
  const [order, setOrder] = useState(saved);
  const [saves, setSaves] = useState(0);
  return <main>
    <SortableList label="Allowed executors" items={order.map(key => ({ key, label: labels[key]! }))}
      onReorder={setOrder} onRemove={key => setOrder(current => current.filter(item => item !== key))} />
    <SaveBar count={orderChanges(saved, order)} onDiscard={() => setOrder(saved)} onSave={() => setSaves(value => value + 1)} />
    <output data-testid="order">{order.join(',')}</output>
    <output data-testid="saves">{saves}</output>
  </main>;
}

const config = dispatchConfigSchema.parse({});
const view = { strategy: 'default', planner: 'codex', plannerAccount: 'work', source: 'built-in' as const, config };
const state = { ...initialState(), connected: true, features: { readModel: true, ops: new Set(['routing.get', 'routing.set']) } };

let pending: Rule[] | undefined;
const explained = {
  schemaVersion: 1, revision: 'r1', at: 0, observedAt: null, outcome: 'select', kind: { value: 'tests', source: 'given' },
  strategy: { name: 'default', draft: true, source: 'strategy' }, engine: { id: 'ladder', version: '1' },
  chosen: { executor: 'codex', account: 'work', runner: 'codex', model: { kind: 'executor-default' }, host: null },
  step: { id: 'usable-fallback', index: 1, skipped: [] },
  reasons: [{ code: 'step_match', outcome: 'pass', facts: { stepId: 'usable-fallback', kind: 'tests' } }, { code: 'brand_new_code', outcome: 'info', facts: {} }],
  fallbacks: [{ executor: 'claude-code', runner: 'claude-code', account: 'team', state: 'excluded', reason: { code: 'quota_exhausted', outcome: 'fail', facts: {} } }],
  planner: { state: 'unknown', reason: 'planner_not_measured' }, uncertainty: [{ code: 'cached_preview', outcome: 'info', facts: {} }],
};
const tryState = { ...state, snapshot: { ...initialState().snapshot, repos: [{ key: 'repo-a', label: 'repo-a' }] }, features: { readModel: true, ops: new Set(['routing.get', 'routing.set', 'dispatch.explain']) } };
/** `#try`: the editor's unsaved ladder flows into Try a task, which calls dispatch.explain. */
function Try() {
  const [draft, setDraft] = useState<StrategyDraft>();
  const [sent, setSent] = useState('');
  const [called, setCalled] = useState('');
  const mode = location.hash;
  const api = { call: async (op: string, params: unknown) => {
    if (op === 'dispatch.explain' || op === 'dispatch.preview') {
      setSent(JSON.stringify(params)); setCalled(op);
      if (op === 'dispatch.preview') return { validation: 'valid', proposal: null, recommendedAction: 'queue', excluded: [], uncertainty: [] };
      const result = { ...explained, strategy: { ...explained.strategy, draft: !!(params as { strategyDraft?: unknown }).strategyDraft } };
      return mode === '#try-no-choice' ? { ...result, chosen: null, outcome: 'fail', reasons: [], fallbacks: [{ executor: 'codex', runner: 'codex#team', account: 'team', state: 'eligible' }] } : result;
    }
    return {};
  } };
  return <TaskContext.Provider value={{ state: mode === '#try-preview' ? { ...tryState, features: { ...tryState.features, ops: new Set(['routing.get', 'routing.set', 'dispatch.preview']) } } : tryState, api } as never}>
    <main>
      <SetupEditor view={view} eligibility={{ kind: 'global', rules: [{ executors: ['codex'] }], available: ['codex'] }} onDirtyChange={() => {}} onSaved={() => {}} onLadderDraft={setDraft} />
      <DispatcherPreviewForm query={{} as never} draft={draft} />
      <output data-testid="sent">{sent}</output>
      <output data-testid="called">{called}</output>
    </main>
  </TaskContext.Provider>;
}
/** The real guided-setup editor against a fake service; `#setup-fail` makes strategy.save fail. */
function Setup() {
  const [rules, setRules] = useState<Rule[]>([{ kinds: ['tests'], executors: ['codex'] }, { executors: ['claude-code'] }]);
  const [calls, setCalls] = useState<string[]>([]);
  const api = { call: async (op: string, params: { rules?: Rule[] }) => {
    setCalls(current => [...current, op]);
    if (op === 'routing.set') { pending = params.rules!; return {}; }
    if (op === 'dispatch.config.get') return view;
    if (op === 'strategy.preview') return { ok: true, errors: [] };
    if (op === 'strategy.save' && location.hash === '#setup-fail') throw new Error('name taken');
    return {};
  } };
  return <TaskContext.Provider value={{ state, api } as never}>
    <main>
      <SetupEditor view={view} eligibility={{ kind: 'global', rules, available: ['claude-code', 'codex', 'opencode'] }}
        onDirtyChange={() => {}} onSaved={() => { if (pending) setRules(pending); }} />
      <button id="other-client" onClick={() => setRules([{ kinds: ['tests'], executors: ['opencode'] }, { executors: ['codex'] }])}>Simulate another client</button>
      <output data-testid="calls">{calls.join(',')}</output>
    </main>
  </TaskContext.Provider>;
}

render(location.hash.startsWith('#try') ? <Try /> : location.hash.startsWith('#setup') ? <Setup /> : <Fixture />, document.getElementById('root')!);
