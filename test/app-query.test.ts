import { expect, test } from 'bun:test';
import { createQuery, type QueryState } from '../app/src/data/query';
import { queryRevision } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import snapshot from './fixtures/ui/snapshot.json';
import type { ClientSnapshot } from '../src/view-model/snapshot';

function deferredApi() {
  const calls: { op: string; params: unknown; resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  let concurrent = 0, maxConcurrent = 0;
  return {
    calls,
    get maxConcurrent() { return maxConcurrent; },
    call(op: string, params: unknown) {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise<string>((resolve, reject) => calls.push({ op, params,
        resolve: value => { concurrent--; resolve(value); },
        reject: error => { concurrent--; reject(error); },
      }));
    },
  };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

for (const op of ['task.get', 'task.diff']) test(`${op} publishes a slow first result and coalesces revisions into one follow-up`, async () => {
  const api = deferredApi(), states: QueryState<string>[] = [];
  const query = createQuery(api.call, state => states.push(state));
  const params = JSON.stringify({ id: 't-one' });
  query.update(op, params, '1');
  query.update(op, params, '2');
  query.update(op, params, '3');
  query.update(op, params, '3');
  expect(api.calls).toHaveLength(1);
  api.calls[0]!.resolve('first task result');
  await settle();
  expect(states.some(state => state.data === 'first task result' && !state.loading)).toBe(true);
  expect(states.at(-1)).toEqual({ data: 'first task result', loading: true });
  expect(api.calls).toHaveLength(2);
  expect(api.maxConcurrent).toBe(1);
  api.calls[1]!.resolve('updated task result');
  await settle();
  query.update(op, params, '3');
  expect(states.at(-1)).toEqual({ data: 'updated task result', loading: false });
  expect(api.calls).toHaveLength(2);
  query.dispose();
});

test('parameter changes isolate results and returning to a pending query coalesces it', async () => {
  const api = deferredApi(), states: QueryState<string>[] = [];
  const query = createQuery(api.call, state => states.push(state));
  query.update('task.get', '{"id":"one"}', '1');
  query.update('task.get', '{"id":"two"}', '1');
  api.calls[0]!.resolve('one');
  await settle();
  expect(states.at(-1)?.data).toBeUndefined();
  query.update('task.get', '{"id":"two"}', '2');
  query.update('task.get', '{"id":"one"}', '2');
  query.update('task.get', '{"id":"two"}', '2');
  expect(api.calls.filter(call => (call.params as { id: string }).id === 'two')).toHaveLength(1);
  api.calls[1]!.resolve('two');
  await settle();
  expect(states.at(-1)?.data).toBe('two');
  query.dispose();
});

test('refresh errors retain data and disposed queries cannot publish or refetch', async () => {
  const api = deferredApi(), states: QueryState<string>[] = [];
  const query = createQuery(api.call, state => states.push(state));
  query.update('task.get', '{}', '1');
  api.calls[0]!.resolve('visible');
  await settle();
  query.update('task.get', '{}', '2');
  const error = new Error('offline');
  api.calls[1]!.reject(error);
  await settle();
  expect(states.at(-1)).toEqual({ data: 'visible', error, loading: false });
  query.update('task.get', '{}', '3');
  query.update('task.get', '{}', '4');
  query.dispose();
  const count = states.length;
  api.calls[2]!.resolve('ignored');
  await settle();
  expect(states).toHaveLength(count);
  expect(api.calls).toHaveLength(3);
});

test('task query revisions ignore unrelated snapshot, configuration and activity changes', () => {
  const state = { ...initialState(), snapshot: snapshot as unknown as ClientSnapshot };
  const task = state.snapshot.tasks[0]!;
  for (const op of ['task.get', 'task.diff']) {
    const revision = queryRevision(state, op, { id: task.id });
    const unrelated = { ...state, invalidations: { config: 10 }, snapshot: { ...state.snapshot, seq: state.snapshot.seq + 1,
      tasks: state.snapshot.tasks.map(t => t.id === task.id ? t : { ...t, updatedAt: t.updatedAt + 1 }) },
      activity: [{ id: 'a-1', taskId: 'another-task' }] as typeof state.activity };
    expect(queryRevision(unrelated, op, { id: task.id })).toBe(revision);
    expect(queryRevision({ ...state, snapshot: { ...state.snapshot, tasks: state.snapshot.tasks.map(t => t.id === task.id ? { ...t, updatedAt: t.updatedAt + 1 } : t) } }, op, { id: task.id })).not.toBe(revision);
    expect(queryRevision({ ...unrelated, activity: [{ id: 'a-2', taskId: task.id }] as typeof state.activity }, op, { id: task.id })).not.toBe(revision);
  }
});

test('takeover data is cached during refresh and remains isolated by task', async () => {
  const api = deferredApi(), states: QueryState<string>[] = [];
  const query = createQuery(api.call, state => states.push(state));
  const one = JSON.stringify({ id: 'one' }), two = JSON.stringify({ id: 'two' });
  query.update('task.session', one, '1');
  api.calls[0]!.resolve('read-only');
  await settle();
  query.update('task.session', one, '2');
  query.setData('task.session', one, 'driving');
  expect(states.at(-1)).toEqual({ data: 'driving', error: undefined, loading: true });
  query.update('task.session', one, '2');
  expect(states.at(-1)?.data).toBe('driving');
  expect(api.calls).toHaveLength(2);
  query.update('task.session', two, '1');
  const count = states.length;
  query.setData('task.session', one, 'driving update');
  expect(states).toHaveLength(count);
  api.calls[1]!.resolve('refreshed driving');
  api.calls[2]!.resolve('other task');
  await settle();
  expect(states.at(-1)?.data).toBe('other task');
  query.dispose();
  query.setData('task.session', two, 'ignored');
  expect(states.at(-1)?.data).toBe('other task');
});

test('task history invalidates on task revisions, not just configuration',()=>{
 const state={...initialState(),snapshot:snapshot as unknown as ClientSnapshot};
 const before=queryRevision(state,'task.list',{});
 const updated={...state,snapshot:{...state.snapshot,tasks:state.snapshot.tasks.map((t,i)=>i===0?{...t,rev:(t.rev??0)+1,state:'done'}:t)}};
 expect(queryRevision(updated,'task.list',{})).not.toBe(before);
});

test('work rows refresh when a node starts, settles or appears, so a running tree shows its new tokens',()=>{
 const state={...initialState(),snapshot:snapshot as unknown as ClientSnapshot};
 const params={relation:'all',limit:100};
 const before=queryRevision(state,'dispatch.list',params);
 const settled={...state,snapshot:{...state.snapshot,tasks:state.snapshot.tasks.map((t,i)=>i===0?{...t,state:t.state==='done'?'running':'done'}:t)}};
 expect(queryRevision(settled,'dispatch.list',params)).not.toBe(before);
 const added={...state,snapshot:{...state.snapshot,tasks:[...state.snapshot.tasks,{...state.snapshot.tasks[0]!,id:'t-new-child'}]}};
 expect(queryRevision(added,'dispatch.list',params)).not.toBe(before);
 // Progress ticks on a running task must not refetch a hundred work rows each time.
 const progress={...state,snapshot:{...state.snapshot,tasks:state.snapshot.tasks.map((t,i)=>i===0?{...t,rev:(t.rev??0)+1,updatedAt:t.updatedAt+5}:t)}};
 expect(queryRevision(progress,'dispatch.list',params)).toBe(before);
});

test('filtered reads opt in to previous data across keys without publishing late answers or hiding errors', async () => {
  const api = deferredApi(), states: QueryState<string>[] = [];
  const query = createQuery(api.call, state => states.push(state), true);
  query.update('insights.summary', '{"period":"7d"}', '1');
  api.calls[0]!.resolve('last visible');
  await settle();
  query.update('insights.summary', '{"period":"today"}', '1');
  expect(states.at(-1)).toEqual({data:'last visible',loading:true});
  query.update('insights.summary', '{"period":"30d","repo":"two"}', '1');
  api.calls[1]!.resolve('late today');
  await settle();
  expect(states.at(-1)?.data).toBe('last visible');
  const error = new Error('offline');
  api.calls[2]!.reject(error);
  await settle();
  expect(states.at(-1)).toEqual({data:'last visible',loading:false,error});
  query.update('version.get', '{}', '1');
  expect(states.at(-1)?.data).toBeUndefined();
  query.dispose();
});
