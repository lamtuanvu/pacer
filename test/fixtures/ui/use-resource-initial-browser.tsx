import { render } from 'preact';
import { useResource } from '../../../app/src/screens/settings/shared';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { initialState } from '../../../app/src/data/store';

const calls: { op: string; params: any }[] = [];
(window as any).calls = calls;
const resolvers: Array<(value: any) => void> = [];
(window as any).resolveNext = (value: any) => resolvers.shift()?.(value ?? { value: 42 });

const api = {
  call: async (op: string, params: any) => {
    calls.push({ op, params });
    return new Promise(resolve => { resolvers.push(resolve); });
  },
} as any;

const runner = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });

function Consumer() {
  const resource = useResource<{ value: number }>('foo.get', {}, { value: 9 });
  return <div>
    <span id="status" data-loading={String(resource.loading)} data-refreshing={String(resource.refreshing)} data-hasdata={String(resource.data !== undefined)} />
    {resource.data && <span id="value">{resource.data.value}</span>}
  </div>;
}

render(
  <ActionContext.Provider value={runner}>
    <TaskContext.Provider value={{ state: initialState(), api }}>
      <Consumer />
    </TaskContext.Provider>
  </ActionContext.Provider>,
  document.getElementById('app')!,
);
