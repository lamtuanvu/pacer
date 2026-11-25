import { render } from 'preact';
import { useState } from 'preact/hooks';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { NotificationProvider } from '../../../app/src/data/notification-context';
import { initialState, reduceStore, type StoreState } from '../../../app/src/data/store';
import { WorkView } from '../../../app/src/screens/work/WorkView';
import { JobList } from '../../../app/src/screens/settings/shared';
import { FirstRun } from '../../../app/src/screens/setup/Setup';
import { MachineSection } from '../../../app/src/screens/settings/Machines';
import snapshot from './snapshot.json';

const screen = new URLSearchParams(location.search).get('screen') ?? 'work';
const task = snapshot.tasks[0]!;
const calls: { op: string; params: any }[] = [];
(window as any).calls = calls;
(window as any).snapshotTask = task;

const tree = {
  rootId: task.id,
  nodes: [],
  totals: {
    tasks: 1, running: 1, queued: 0, executionSeconds: 0, queueWaitSeconds: 0,
    dependencyWaitSeconds: null, childWaitSeconds: null, capacityWaitSeconds: null,
    provisionalWaits: 0, usagePools: [],
  },
};
const taskDetail = { id: task.id, state: 'running', rev: task.rev, goal: task.goal };

const api = { call: async (op: string, params: any = {}) => {
  calls.push({ op, params });
  switch (op) {
    case 'dispatch.tree': return tree;
    case 'dispatch.events': return { events: [], next: 0, hasMore: false };
    case 'dispatch.analytics': return { groups: [], totalReviews: 0, minimumSamples: 20 };
    case 'job.list': return [{ id: 'job-1', target: 'acct', kind: 'account.usage.check', state: 'running', startedAt: 1, steps: [{ name: 'Check', state: 'running' }] }];
    case 'task.get': return taskDetail;
    case 'task.diff': return { diff: '+ one line' };
    case 'config.get': return { keys: {}, machine: {} };
    case 'host.suggest': return [];
    default: return {};
  }
} } as any;
const actions = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });

const initial: StoreState = {
  ...reduceStore(initialState(), { type: 'snapshot', snapshot: snapshot as never }),
  features: { readModel: true, ops: new Set<string>() },
  connected: true,
};

function Fixture() {
  const [state, setState] = useState(initial);
  (window as any).emit = (type: string, data: unknown) => setState(current => reduceStore(current, {
    type: 'event',
    event: { type: type as never, seq: (current.snapshot?.seq ?? 0) + 1, at: (current.snapshot?.at ?? 0) + 1, data: data as never },
  }));
  const view = screen === 'jobs' ? <JobList target="acct" onComplete={() => {}} />
    : screen === 'setup' ? <FirstRun id={task.id} run={async () => {}} />
    : screen === 'machines' ? <MachineSection />
    : <WorkView id={task.id} />;
  return <NotificationProvider><ActionContext.Provider value={actions}>
    <TaskContext.Provider value={{ state, api }}>{view}</TaskContext.Provider>
  </ActionContext.Provider></NotificationProvider>;
}

render(<Fixture />, document.getElementById('app')!);
