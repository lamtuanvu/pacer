import { render } from 'preact';
import { TasksPage } from '../../../app/src/screens/session/TasksPage';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { initialState } from '../../../app/src/data/store';
import type { TaskNodeView } from '../../../src/view-model/task-tree';

const leaf = (id: string, title: string, over: Partial<TaskNodeView> = {}): TaskNodeView => ({
  id, title, state: { tone: 'info', live: true, label: 'Working' }, active: true, attention: 'none', bucket: 'running',
  host: { name: 'This Mac', kind: 'local' }, agents: ['codex'], meta: [{ icon: 'time', text: 'running for 4m' }], children: [], ...over,
});
const nodes: TaskNodeView[] = [
  leaf('t-1', 'Fix the retry bug', { attention: 'bad', attentionLabel: 'Checks failed', bucket: 'needs', state: { tone: 'bad', live: false, label: 'Failed' }, active: false, tokens: '214k tokens',
    children: [leaf('t-2', 'Write the regression test'), leaf('t-3', 'Capture screenshots', { state: { tone: 'good', live: false, label: 'Completed' }, active: false, bucket: 'accepted' })] }),
  leaf('t-4', 'Document the budget store'),
  ...Array.from({ length: 24 }, (_, index) => leaf(`t-x${index}`, `Background task ${index}`, { bucket: 'accepted', active: false, state: { tone: 'good', live: false, label: 'Completed' } })),
];
const state = { ...initialState(), connected: true } as never;
render(<TaskContext.Provider value={{ state, api: { call: async () => ({}) } as never }}>
  <TasksPage nodes={nodes} repos={[{ key: 'a', label: 'org/a', path: '/a' }]} query={{ repo: null, scope: null } as never} onNew={() => { (window as unknown as { newTask: number }).newTask = 1; }} hasOlder={false} loadingOlder={false} onLoadOlder={() => {}} />
</TaskContext.Provider>, document.getElementById('root')!);
