import { expect, test } from 'bun:test';
import fixture from './fixtures/ui/snapshot.json';
import { initialState, reduceStore } from '../app/src/data/store';
import { queryRevision } from '../app/src/screens/task-shared';
import { createActionRunner } from '../app/src/data/actions';
const ready = () => reduceStore(initialState(), {type:'snapshot',snapshot:fixture as never});
test('config events invalidate their area without requesting a snapshot', () => {
  const state = ready();
  const next = reduceStore(state,{type:'event',event:{type:'config',seq:state.snapshot!.seq+1,at:1,data:{area:'config',at:1}}});
  expect(next.needsSnapshot).toBe(false);
  expect(next.invalidations.config).toBe(1);
  expect(queryRevision(next,'runner.list',{})).toBe(queryRevision(state,'runner.list',{}));
  expect(queryRevision(next,'config.get',{})).not.toBe(queryRevision(state,'config.get',{}));
});
test('reconnection retains snapshot without requesting resync, reset requests resync', () => {
  const state = ready();
  const disconnected = reduceStore(state,{type:'disconnected'});
  const next = reduceStore(disconnected,{type:'reconnected'});
  expect(next.snapshot).toBe(state.snapshot); expect(next.needsSnapshot).toBe(false);
  expect(reduceStore(next,{type:'event',event:{type:'reset',seq:0,at:1,data:{}}}).needsSnapshot).toBe(true);
});
test('review, mode and desktop actions do not refresh the whole store', async () => {
  let reads = 0;
  const runner = createActionRunner({call:async <T>() => ({} as T),waitFor:async()=>false,refetch:()=>{reads++;},navigate(){}});
  for (const op of ['task.review','mode.hold','desktop.update.cancel']) await runner.run(op,{label:op,op,params:{}});
  expect(reads).toBe(0);
});

class Events {
  static instances: Events[] = [];
  listeners = new Map<string, (event: unknown) => void>();
  closed = false;
  constructor(readonly url: string) { Events.instances.push(this); }
  addEventListener(type: string, callback: (event: unknown) => void) { this.listeners.set(type, callback); }
  close() { this.closed = true; }
  emit(type: string, data = {}, seq = 1) { this.listeners.get(type)?.({data:JSON.stringify(data),lastEventId:String(seq)}); }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
test('transport retry replays the cursor without another snapshot; reset and protocol changes resync', async () => {
  const { createStore } = await import('../app/src/data/store');
  Events.instances = [];
  let reads = 0, protocol = '3.0.0';
  const api = {hello:async()=>({protocol,pacer:'1.0.0',ops:[],events:['task','config','reset','attention']}),snapshot:async()=>{reads++;return {protocol,seq:protocol === "3.1.0" ? 4 : 10,snapshot:fixture as never};},call:async<T>()=>({} as T)};
  const store = createStore(api, Events as unknown as typeof EventSource), stop = store.start();
  try {
    await flush(); const source = Events.instances[0]!; source.emit('open');
    source.emit('config',{area:'config',at:1},11);
    expect(reads).toBe(1);
    source.emit('error'); expect(store.getState().snapshot).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 1100));
    const reconnected = Events.instances.at(-1)!;
    expect(reconnected.url).toBe('/v3/events?since=11'); reconnected.emit('open');
    expect(store.getState().connected).toBe(true); expect(reads).toBe(1);
    reconnected.emit('reset',{},12); await flush(); expect(reads).toBe(2);
    Events.instances.at(-1)!.emit('open'); protocol = '3.1.0'; Events.instances.at(-1)!.emit('error');
    await new Promise(resolve => setTimeout(resolve, 1100)); expect(reads).toBe(3); expect(store.getState().snapshot?.seq).toBe(4);
  } finally { stop(); }
});
test('entity payloads update the snapshot directly, while messages invalidate only their task', () => {
  const state = {...ready(),features:{readModel:true,ops:new Set<string>()}};
  const task = {...state.snapshot!.tasks[0]!,rev:42};
  const next = reduceStore(state,{type:'event',event:{type:'task',seq:state.snapshot!.seq+1,at:1,data:task}});
  expect(next.snapshot!.tasks.find(row=>row.id===task.id)?.rev).toBe(42);
  expect(next.needsSnapshot).toBe(false); expect(next.invalidations).toEqual({});
  const before = queryRevision(next,'task.get',{id:task.id});
  const message = reduceStore(next,{type:'event',event:{type:'message',seq:next.snapshot!.seq+1,at:1,data:{taskId:task.id}}});
  expect(queryRevision(message,'task.get',{id:task.id})).not.toBe(before);
  expect(queryRevision(message,'task.get',{id:'unrelated'})).toBe(queryRevision(next,'task.get',{id:'unrelated'}));
});

test('account pickers invalidate on accounts and unmapped reads fail safe for every emitted config area', async () => {
  const areas = new Set<string>();
  for await (const file of new Bun.Glob('**/*.ts').scan('src')) {
    if (file.endsWith('assets.generated.ts')) continue;
    const source = await Bun.file(`src/${file}`).text();
    for (const match of source.matchAll(/(?:mutation|publishConfigChange)\(ctx,\s*["']([^"']+)["']/g)) areas.add(match[1]!);
  }
  const state = ready();
  for (const area of areas) {
    const next = reduceStore(state,{type:'event',event:{type:'config',seq:state.snapshot!.seq+1,at:1,data:{area,at:1}}});
    for (const op of ['terminal.list','repo.list','insights.summary']) expect(queryRevision(next,op,{})).not.toBe(queryRevision(state,op,{}));
    if (area === 'accounts') expect(queryRevision(next,'account.list',{})).not.toBe(queryRevision(state,'account.list',{}));
  }
  expect(areas.has('accounts')).toBe(true);
  const mapped = JSON.parse(queryRevision(state,'config.get',{})).map(([area]: [string,number])=>area);
  expect(mapped.sort()).toEqual([...areas].sort());
});
test('first stream open does not revalidate; a drop revalidates once and reset only refetches snapshot', async () => {
  const { createStore } = await import('../app/src/data/store');
  Events.instances = [];
  let reads = 0;
  const api = {hello:async()=>({protocol:'3.0.0',pacer:'1.0.0',ops:[],events:['reset']}),snapshot:async()=>{reads++;return {protocol:'3.0.0',seq:10,snapshot:fixture as never};},call:async<T>()=>({} as T)};
  const store = createStore(api,Events as unknown as typeof EventSource), stop = store.start();
  try {
    await flush(); const first = Events.instances.at(-1)!;
    first.emit('open'); expect(store.getState().connectionRevision).toBe(0);
    first.emit('error'); expect(store.getState().connectionRevision).toBe(0);
    await new Promise(resolve=>setTimeout(resolve,1100));
    const second = Events.instances.at(-1)!; second.emit('open'); second.emit('open');
    expect(store.getState().connectionRevision).toBe(1);
    second.emit('reset',{},11); await flush();
    expect(reads).toBe(2); Events.instances.at(-1)!.emit('open');
    expect(store.getState().connectionRevision).toBe(1);
  } finally { stop(); }
});
test('shared screen reads work between snapshot and first stream open and through a blip', async () => {
  const { createApi } = await import('../app/src/data/api');
  const { createStore } = await import('../app/src/data/store');
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => Response.json(String(input).endsWith('/hello') ? {protocol:'3.0.0',pacer:'one',ops:[],events:[]} : String(input).endsWith('/snapshot') ? {seq:10,snapshot:fixture} : {result:{ok:true}})) as typeof fetch;
  Events.instances = [];
  const api = createApi(), store = createStore(api,Events as unknown as typeof EventSource), stop = store.start();
  try {
    await flush(); expect(store.getState().snapshot).not.toBeNull();
    await expect(api.call('setup.check',{})).resolves.toEqual({ok:true});
    Events.instances.at(-1)!.emit('open'); Events.instances.at(-1)!.emit('error');
    await expect(api.call('plugin.list',{})).resolves.toEqual({ok:true});
  } finally { stop(); globalThis.fetch = original; }
});
test('service pacer identity changes force a snapshot even when protocol is unchanged', async () => {
  const { createStore } = await import('../app/src/data/store');
  Events.instances = []; let pacer = 'one', reads = 0;
  const api = {hello:async()=>({protocol:'3.0.0',pacer,ops:[],events:[]}),snapshot:async()=>{reads++;return {protocol:'3.0.0',seq:10,snapshot:fixture as never};},call:async<T>()=>({} as T)};
  const store = createStore(api,Events as unknown as typeof EventSource), stop = store.start();
  try { await flush(); Events.instances.at(-1)!.emit('open'); pacer='two'; Events.instances.at(-1)!.emit('error'); await new Promise(resolve=>setTimeout(resolve,1100)); expect(reads).toBe(2); }
  finally { stop(); }
});

test('reads still reach HTTP after a sustained disconnect while live actions are refused', async () => {
  const { createApi } = await import('../app/src/data/api');
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (input: unknown) => { calls++; return Response.json(String(input).endsWith('/hello') ? {protocol:'3.0.0',pacer:'one',ops:[],events:[]} : {result:{ok:true}}); }) as typeof fetch;
  const api = createApi();
  try {
    await api.hello(); api.setConnected!(false);
    for (const op of ['plugin.ui.render','routing.route','msg.policy','session.file.read']) await expect(api.call(op,{})).resolves.toEqual({ok:true});
    const before = calls;
    await expect(api.call('task.answer',{})).rejects.toMatchObject({code:'offline'});
    expect(calls).toBe(before);
  } finally { globalThis.fetch = original; }
});
test('shared API actions stay online before open and during grace, then refuse after a sustained drop', async () => {
  const { createApi } = await import('../app/src/data/api');
  const { createStore } = await import('../app/src/data/store');
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => Response.json(String(input).endsWith('/hello') ? {protocol:'3.0.0',pacer:'one',ops:[],events:[]} : String(input).endsWith('/snapshot') ? {seq:10,snapshot:fixture} : {result:{ok:true}})) as typeof fetch;
  Events.instances = [];
  const api = createApi(), store = createStore(api,Events as unknown as typeof EventSource), stop = store.start();
  try {
    await flush(); await expect(api.call('task.answer',{})).resolves.toEqual({ok:true});
    Events.instances.at(-1)!.emit('open'); Events.instances.at(-1)!.emit('error');
    await expect(api.call('task.answer',{})).resolves.toEqual({ok:true});
    await new Promise(resolve=>setTimeout(resolve,2100));
    await expect(api.call('task.answer',{})).rejects.toMatchObject({code:'offline'});
    await expect(api.call('setup.check',{})).resolves.toEqual({ok:true});
    Events.instances.at(-1)!.emit('open');
    await expect(api.call('task.answer',{})).resolves.toEqual({ok:true});
  } finally { stop(); globalThis.fetch = original; }
});

test('connected store refreshes folder wait status without replacing streamed state', async () => {
  const { createStore } = await import('../app/src/data/store');
  const original = globalThis.setInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return 1 as any; }) as typeof setInterval;
  let waiting: { kind: 'folder'; path: string; since: number } | undefined;
  const api = {hello:async()=>({protocol:'3.0.0',pacer:'1.0.0',ops:[],events:['config']}),snapshot:async()=>({protocol:'3.0.0',seq:10,snapshot:{...fixture,service:{...fixture.service,waiting}} as never}),call:async<T>()=>({} as T)};
  const store = createStore(api, Events as unknown as typeof EventSource), stop = store.start();
  try {
    await flush(); Events.instances.at(-1)!.emit('open');
    expect(tick).toBeDefined();
    waiting = {kind:'folder',path:'/repo/.git/HEAD',since:1};
    tick!(); await flush();
    expect(store.getState().snapshot?.service?.waiting).toEqual(waiting);
    waiting = undefined; tick!(); await flush();
    expect(store.getState().snapshot?.service?.waiting).toBeUndefined();
  } finally { stop(); globalThis.setInterval = original; }
});
