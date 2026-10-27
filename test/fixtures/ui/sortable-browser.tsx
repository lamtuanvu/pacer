import { render } from 'preact';
import { useState } from 'preact/hooks';
import { SortableList } from '../../../app/src/ds/SortableList';
import { SaveBar } from '../../../app/src/ds/SaveBar';
import { orderChanges } from '../../../app/src/model/dispatcher-setup';
import { SetupEditor } from '../../../app/src/screens/settings/DispatcherSetup';
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

render(location.hash.startsWith('#setup') ? <Setup /> : <Fixture />, document.getElementById('root')!);
