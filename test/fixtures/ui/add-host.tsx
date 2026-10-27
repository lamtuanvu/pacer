import { render } from 'preact';
import { useState } from 'preact/hooks';
import { AddHost } from '../../../app/src/screens/settings/Machines';
import { Stepper } from '../../../app/src/ds/Stepper';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { NotificationProvider } from '../../../app/src/data/notification-context';
import { initialState } from '../../../app/src/data/store';

const calls: [string, unknown][] = [];
let checks = 0, failFirst = false;
Object.assign(window, { hostFixture: { calls: () => calls, failFirst: (value: boolean) => { failFirst = value; } } });
const step = (name: string, state: string, detail?: string) => ({ name, state, ...(detail ? { detail } : {}) });
const api = { call: async (op: string, params: any) => {
  calls.push([op, params]);
  if (op === 'host.suggest') return ['devbox', 'pi-lab'];
  if (op === 'host.add') return { alias: params.alias };
  if (op === 'host.check') return { job: { id: `j${++checks}`, kind: 'host.check', target: params.alias, state: 'running', steps: [step('ssh', 'running'), step('git', 'pending')], startedAt: 1 } };
  if (op === 'job.get') {
    const bad = failFirst && checks === 1;
    return { id: params.id, kind: 'host.check', target: calls.find(c => c[0] === 'host.add')![1] && (calls.find(c => c[0] === 'host.add')![1] as any).alias, state: bad ? 'failed' : 'passed',
      steps: bad ? [step('ssh', 'failed', 'unreachable'), step('git', 'skipped', 'skipped')] : [step('ssh', 'passed'), step('git', 'passed', '2.47.0')], startedAt: 1, endedAt: 2 };
  }
  return {};
} } as any;
const actions = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
function App() {
  const state = { ...initialState(), connected: true, snapshot: { at: 1, hosts: [{ alias: 'taken', ssh: 'taken', state: 'ready', running: 0, maxTasks: 2, executors: [], repos: 0 }] } } as any;
  const [step, setStep] = useState('1');
  return <TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={actions}>
    <AddHost initialAliases={['devbox', 'pi-lab']} />
    <Stepper label="Wizard" onSelect={setStep} steps={['A', 'B', 'C', 'D'].map((title, i) => ({ id: String(i + 1), title, state: String(i + 1) === step ? 'current' : 'todo', reachable: i < 3 }))} />
    <output id="picked">{step}</output>
  </ActionContext.Provider></TaskContext.Provider>;
}
render(<NotificationProvider><App /></NotificationProvider>, document.getElementById('app')!);
