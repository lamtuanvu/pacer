import { render } from 'preact';
import { useState } from 'preact/hooks';
import { TaskTree } from '../../../app/src/ds/TaskTreeNode';
import type { TaskNodeView } from '../../../src/view-model/task-tree';

const leaf = (id: string, title: string, over: Partial<TaskNodeView> = {}): TaskNodeView => ({
  id, title, state: { tone: 'info', live: true, label: 'Working' }, active: true, attention: 'none', bucket: 'running',
  host: { name: 'This Mac', kind: 'local' }, agents: ['codex'], meta: [{ icon: 'time', text: 'running for 4m' }], children: [], ...over,
});
const root = (title: string, extra: TaskNodeView[] = []): TaskNodeView => leaf('t-1', title, {
  attention: 'warn', attentionLabel: 'Review requested', agents: ['codex', 'claude-code'],
  children: [leaf('t-2', 'Write the keepalive test'), leaf('t-3', 'Document the setting', { state: { tone: 'good', live: false, label: 'Completed' }, active: false }), ...extra],
});
const params = new URLSearchParams(location.search);

function Preview() {
  const [nodes, setNodes] = useState<TaskNodeView[]>([root('Add SSH keepalive to remote runs'), leaf('t-8', 'Bump yaml')]);
  (window as unknown as { refresh(): void }).refresh = () =>
    setNodes([leaf('t-8', 'Bump yaml'), root('Add SSH keepalive to remote runs (updated)', [leaf('t-4', 'New child')])]);
  return <TaskTree nodes={nodes} density={params.get('density') === 'compact' ? 'compact' : 'regular'} href={id => `#/tasks/${id}`} selectedId={params.get('selected') ?? undefined} label="Tasks" />;
}
render(<Preview />, document.getElementById('root')!);
