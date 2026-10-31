import { render } from 'preact';
import { useState } from 'preact/hooks';
import { TaskContext, useQuery } from '../../app/src/screens/task-shared';
import { initialState } from '../../app/src/data/store';

const renders: { owner: boolean; data?: string }[] = [];
const pending: { op: string; params: unknown; resolve: (value: string) => void }[] = [];
const api = {
  call: <T,>(op: string, params: unknown) => new Promise<T>(resolve => {
    pending.push({ op, params, resolve: resolve as (value: string) => void });
  }),
  hello: async () => ({}),
  snapshot: async () => ({}),
};
const otherApi = { ...api };
const state = { ...initialState(), connected: true };

function Consumer({ id, owner }: { id: string; owner: boolean }) {
  const query = useQuery<string>('task.get', { id });
  renders.push({ owner, data: query.data });
  return <p data-id={id}>{query.data ?? 'loading'}</p>;
}

function App() {
  const [epoch, setEpoch] = useState(0);
  const [owner, setOwner] = useState(false);
  const [id, setId] = useState('one');
  const [count, setCount] = useState(2);
  Object.assign(window, { queryFixture: { pending, renders, setId, setCount, setOwner, setEpoch } });
  return <TaskContext.Provider value={{ api: (owner ? otherApi : api) as any, state: { ...state, connectionRevision: epoch } }}>
    {Array.from({ length: count }, (_, i) => <Consumer key={i} id={id} owner={owner} />)}
  </TaskContext.Provider>;
}
render(<App />, document.getElementById('app')!);
