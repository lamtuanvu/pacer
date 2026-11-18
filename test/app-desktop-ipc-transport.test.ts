import { expect, test } from 'bun:test';
import { createDesktopPlatform } from '../app/src/platform/desktop';
import { buildApp } from '../app/build';

function bridge(rejectCommand?: string) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  class Channel { onmessage: (value: any) => void = () => {}; }
  const adapter = createDesktopPlatform({ __TAURI__: { core: { Channel, invoke: async (command: string, args = {}) => {
    calls.push({ command, args });
    if (command === rejectCommand) throw Error("queue full");
    return { status: 409, body: Array.from(new TextEncoder().encode(JSON.stringify({error:{code:'conflict',message:'Changed',data:{rev:2}}}))) };
  } } } });
  return { adapter, calls };
}
test('desktop operations use captured IPC and preserve typed errors and client instance', async () => {
  const {adapter,calls} = bridge();
  const response = await adapter.request('/v3/ops/task.get',{method:'POST',headers:{'X-Pacer-Client-Instance':'page-instance'},body:'{"id":"t1"}'});
  expect(response.status).toBe(409);
  expect((await response.json()).error).toEqual({code:'conflict',message:'Changed',data:{rev:2}});
  expect(calls.at(-1)).toEqual({command:'service_call',args:{op:'task.get',params:{id:'t1'},instance:expect.any(String)}});
});
test('desktop terminal attach forwards a recorded attempt query only for task targets', async () => {
  const {adapter,calls}=bridge();
  const id='t-20261102-090145-e376';
  const attach=async(url:string)=>{const socket=adapter.attachTerminal(url);socket.onopen=()=>socket.send(JSON.stringify({type:'hello',cols:80,rows:24}));await Promise.resolve();};
  await attach(`ws://tauri.localhost/v3/tasks/${id}/session?attempt=2`);
  expect(calls.find(call=>call.command==='terminal_attach')!.args.target).toEqual({kind:'task',id,attempt:2});
  await attach(`ws://tauri.localhost/v2/tasks/${id}/session`);
  expect(calls.filter(call=>call.command==='terminal_attach').at(-1)!.args.target).toEqual({kind:'task',id});
  // Only a task session addresses a recorded attempt, and only with a positive integer.
  for (const url of [`ws://tauri.localhost/v3/tasks/${id}/session?attempt=0`, `ws://tauri.localhost/v3/tasks/${id}/session?attempt=abc`, `ws://tauri.localhost/v3/terminals/12345678-1234-1234-1234-123456789abc/session?attempt=2`]) expect(()=>adapter.attachTerminal(url)).toThrow();
  expect(calls.filter(call=>call.command==='terminal_attach')).toHaveLength(2);
});

test('desktop refuses arbitrary routes and v2 fallback without forwarding them', async () => {
  const {adapter,calls} = bridge();
  for (const path of ['/v2/hello','https://example.com/v3/hello','/v3/ops/task/get','/private']) await expect(adapter.request(path)).rejects.toThrow();
  expect(calls).toEqual([]);
});
test('desktop keeps one event Channel across subscriptions and maps one resync to reset', async () => {
  const {adapter,calls} = bridge();
  const first = adapter.subscribeEvents('/v3/events?since=12');
  const resets: unknown[] = [];
  first.addEventListener('reset', event => resets.push(JSON.parse((event as MessageEvent).data)));
  const channel = calls.find(call=>call.command==='service_events')!.args.channel as {onmessage(value:unknown):void};
  channel.onmessage({type:'resync',id:20,data:'{}'});
  expect(resets).toEqual([{}]);
  first.close();
  const second = adapter.subscribeEvents('/v3/events?since=20'); second.close();
  expect(calls.filter(call=>call.command==='service_events')).toHaveLength(1);
});
test('desktop routes log and assistant streams to typed commands', async () => {
  const {adapter,calls} = bridge();
  const log = adapter.subscribeEvents('/v3/tasks/t-20261102-090145-e376/log?follow=1'); log.close();
  expect(calls.some(call=>call.command==='task_log_follow')).toBe(true);
  const pending = adapter.request('/v3/assistant/turns/turn-12345678-abc/stream');
  expect(calls.some(call=>call.command==='assistant_turn_stream')).toBe(true);
  const response = await pending; await response.body?.cancel();
});
test('desktop attachments use bounded typed commands', async () => {
  const {adapter,calls} = bridge();
  const draft = '12345678-1234-1234-1234-123456789abc';
  await adapter.request(`/v3/attachments?draft=${draft}`);
  await adapter.request(`/v3/attachments/${draft}?draft=${draft}`,{method:'DELETE'});
  await adapter.request(`/v3/attachments?draft=${draft}&batch=${draft}`,{method:'POST',body:new Blob(['hello']),headers:{'X-Pacer-Filename':'a.txt','Content-Type':'text/plain'}});
  expect(calls.map(call=>call.command)).toEqual(['attachment_list','attachment_delete','attachment_upload']);
  expect(calls.at(-1)?.args.bytes).toEqual([104,101,108,108,111]);
});
test('desktop bundle uses relative assets and Tauri style nonce without weakening default source', async () => {
  const files = await buildApp('desktop');
  const html = files.find(file=>file.path==='index.html')!.text;
  expect(html).toContain('href="./app.css"'); expect(html).toContain('src="./app.js"');
  expect(html).toContain('__TAURI_STYLE_NONCE__');
});

test('desktop terminal maps shared frames to typed commands and acknowledges consumed frames', async () => {
  const {adapter,calls}=bridge();
  const socket=adapter.attachTerminal('ws://tauri.localhost/v2/tasks/t-20261102-090145-e376/session');
  socket.onopen=()=>socket.send(JSON.stringify({type:'hello',v:1,cols:80,rows:24,from:42}));
  await Promise.resolve();
  const attach=calls.find(call=>call.command==='terminal_attach')!;
  expect(attach.args.target).toEqual({kind:'task',id:'t-20261102-090145-e376'}); expect(attach.args.from).toBe(42);
  const received:unknown[]=[];socket.onmessage=event=>received.push(event.data);
  (attach.args.channel as {onmessage(value:unknown):void}).onmessage({type:'terminal',frame:{type:'text',data:'{"type":"control","you":true}'},size:32});
  expect(received).toEqual(['{"type":"control","you":true}']);
  socket.send(JSON.stringify({type:'take',force:true})); socket.send(JSON.stringify({type:'size',cols:100,rows:40})); socket.send(JSON.stringify({type:'release'}));socket.close();
  await Promise.resolve();await Promise.resolve();
  expect(calls.map(call=>call.command)).toEqual(['terminal_attach','terminal_ack','terminal_take','terminal_resize','terminal_release','terminal_detach']);
  expect(calls.every(call=>call.args.instance===attach.args.instance)).toBe(true);
});
test('a 1.2 desktop pane forwards its protocol range and focus to the session', async () => {
  const {adapter,calls}=bridge();
  const socket=adapter.attachTerminal('ws://tauri.localhost/v2/tasks/t-20261102-090145-e376/session');
  socket.onopen=()=>{socket.send(JSON.stringify({type:'hello',v:1,versions:[1,2],client:'app',label:'pacer app',cols:80,rows:24}));socket.send(JSON.stringify({type:'focus'}));};
  await Promise.resolve();await Promise.resolve();
  // Rust rebuilds the hello from these fields; the range decides whether the host lets this pane type.
  expect((calls.find(call=>call.command==='terminal_attach')!.args.hello as {versions:number[]}).versions).toEqual([1,2]);
  expect(calls.map(call=>call.command)).toEqual(['terminal_attach','terminal_focus']);
  socket.close();
});
test('desktop receives connection detail from Rust before service reads work', () => {
  const {adapter,calls}=bridge(); const states: unknown[]=[];
  const stop=adapter.subscribeDesktopConnection!(state=>states.push(state));
  const channel=calls.find(call=>call.command==='service_events')!.args.channel as {onmessage(value:unknown):void};
  channel.onmessage({type:'status',status:'incompatible',reason:'oldApp'});
  expect(states.at(-1)).toMatchObject({status:'incompatible',reason:'oldApp'});stop();
});
test('events arriving between snapshot and subscription replay from a bounded page buffer', async () => {
  const {adapter,calls}=bridge(); const stop=adapter.subscribeDesktopConnection!(()=>{});
  const channel=calls.find(call=>call.command==='service_events')!.args.channel as {onmessage(value:unknown):void};
  channel.onmessage({type:'event',event:'task',id:13,data:'{"id":"changed"}'});
  const seen:unknown[]=[];const source=adapter.subscribeEvents('/v3/events?since=12');
  source.addEventListener('task',event=>seen.push(JSON.parse((event as MessageEvent).data)));
  await Promise.resolve();expect(seen).toEqual([{id:'changed'}]);source.close();stop();
});

test('terminal input rejection detaches once and stops accepting input', async () => {
  const {adapter,calls}=bridge('terminal_take');
  const socket=adapter.attachTerminal('ws://tauri.localhost/v3/tasks/t-20261102-090145-e376/session');
  socket.onopen=()=>socket.send(JSON.stringify({type:'hello',cols:80,rows:24}));
  await Promise.resolve();
  socket.send(JSON.stringify({type:'take'}));
  for(let i=0;i<8;i++) await Promise.resolve();
  socket.send(JSON.stringify({type:'take'}));socket.close();
  for(let i=0;i<8;i++) await Promise.resolve();
  expect(calls.filter(c=>c.command==='terminal_detach')).toHaveLength(1);
  expect(calls.filter(c=>c.command==='terminal_take')).toHaveLength(1);
});
test('service identity resync rewinds the page event cursor', async () => {
  const {adapter,calls}=bridge();const source=adapter.subscribeEvents('/v3/events?since=100');
  const seen:unknown[]=[];source.addEventListener('task',e=>seen.push((e as MessageEvent).data));
  const channel=calls.find(c=>c.command==='service_events')!.args.channel as {onmessage(value:unknown):void};
  channel.onmessage({type:'resync',id:2,data:'{}'});
  channel.onmessage({type:'event',event:'task',id:3,data:'new'});
  expect(seen).toEqual(['new']);source.close();
});
test('operations events and terminal attach share exactly the page identity', async () => {
  const {adapter,calls}=bridge();const source=adapter.subscribeEvents('/v3/events');
  await adapter.request('/v3/ops/task.get',{method:'POST',body:'{}'});
  const socket=adapter.attachTerminal('ws://tauri.localhost/v3/tasks/t-20261102-090145-e376/session');
  socket.onopen=()=>socket.send(JSON.stringify({type:'hello',cols:80,rows:24}));await Promise.resolve();
  const identity=calls.find(c=>c.command==='terminal_attach')!.args.instance;
  expect(typeof identity).toBe('string');
  expect(calls.find(c=>c.command==='service_call')!.args.instance).toBe(identity);
  expect(calls.find(c=>c.command==='service_events')!.args.instance).toBe(identity);
  source.close();socket.close();
});
test('a new subscriber receives a buffered service resync even behind its old cursor', async () => {
  const {adapter,calls}=bridge();const stop=adapter.subscribeDesktopConnection!(()=>{});
  const channel=calls.find(c=>c.command==='service_events')!.args.channel as {onmessage(value:unknown):void};
  channel.onmessage({type:'resync',id:2,data:'{}'});
  channel.onmessage({type:'event',event:'task',id:3,data:'new'});
  const source=adapter.subscribeEvents('/v3/events?since=100');const seen:unknown[]=[];
  source.addEventListener('task',e=>seen.push((e as MessageEvent).data));await Promise.resolve();
  expect(seen).toEqual(['new']);source.close();stop();
});
test('assistant resync closes and cancels its owned stream once', async () => {
  const {adapter,calls}=bridge();const response=await adapter.request('/v3/assistant/turns/turn-12345678-abc/stream');
  const stream=calls.find(c=>c.command==='assistant_turn_stream')!;
  const reader=response.body!.getReader();const read=reader.read();
  (stream.args.channel as {onmessage(value:unknown):void}).onmessage({type:'resync'});
  await expect(read).rejects.toThrow('resync');
  for(let i=0;i<8;i++) await Promise.resolve();
  const cancelled=calls.filter(c=>c.command==='stream_cancel');expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.args.streamId).toBe(stream.args.streamId);
});
test('terminal resync reaches the session client before the stream closes', async () => {
  const {adapter,calls}=bridge();const socket=adapter.attachTerminal('ws://tauri.localhost/v3/tasks/t-20261102-090145-e376/session');
  const frames:unknown[]=[];let closed=0;socket.onclose=()=>closed++;
  socket.onopen=()=>socket.send(JSON.stringify({type:'hello',cols:80,rows:24}));socket.onmessage=e=>frames.push(e.data);
  await Promise.resolve();const attach=calls.find(c=>c.command==='terminal_attach')!;
  const channel=attach.args.channel as {onmessage(value:unknown):void};
  channel.onmessage({type:'text',data:'{"type":"resync"}'});channel.onmessage({type:'end'});channel.onmessage({type:'end'});
  expect(frames).toEqual(['{"type":"resync"}']);expect(closed).toBe(1);expect(socket.readyState).toBe(3);
});
test('connection details retain an older service warning for the shell banner', () => {
  const {adapter,calls}=bridge();const states:unknown[]=[];const stop=adapter.subscribeDesktopConnection!(state=>states.push(state));
  const channel=calls.find(c=>c.command==='service_events')!.args.channel as {onmessage(value:unknown):void};
  channel.onmessage({type:'status',status:'connected',warning:'Older service 0.12.0 — update the service.'});
  expect(states.at(-1)).toMatchObject({status:'connected',warning:'Older service 0.12.0 — update the service.'});stop();
});

test('an unsuccessful snapshot preserves a buffered resync for the next subscriber', async () => {
  const {adapter,calls} = bridge();
  const stop = adapter.subscribeDesktopConnection!(() => {});
  const channel = calls.find(call => call.command === 'service_events')!.args.channel as {onmessage(value:unknown):void};
  channel.onmessage({type:'resync',id:2,data:'{}'});
  // An unsuccessful read must leave the reset available for the next subscriber.
  await adapter.request('/v3/snapshot');
  const failed = adapter.subscribeEvents('/v3/events?since=100');
  let resets = 0;
  failed.addEventListener('reset', () => resets++);
  await Promise.resolve();
  expect(resets).toBe(1);
  failed.close();
  stop();
});

test('desktop store recovers from a lag-induced resync without a snapshot replay loop', async () => {
  const {createStore} = await import('../app/src/data/store');
  const {emptySnapshot} = await import('../src/link/envelope');
  const hello = {protocol:'3.0.0',pacer:'1.0.0',ops:['task.list','dispatch.list','task.get'],events:['reset','attention']};
  class Channel { onmessage: (value: any) => void = () => {}; }
  let events: Channel | undefined, reads = 0, healthy = true;
  const adapter = createDesktopPlatform({__TAURI__:{core:{Channel,invoke:async(command,args = {}) => {
    if (command === 'service_events') { events = args.channel as Channel; return; }
    if (!healthy) throw Error('Service request failed');
    // Bound a broken implementation's replay loop so it fails an assertion.
    if (command === 'service_snapshot' && ++reads > 4) throw Error('Repeated resync');
    const value = command === 'service_hello' ? hello : command === 'service_snapshot'
      ? {seq:10,snapshot:emptySnapshot()} : {result:[]};
    return {status:200,body:Array.from(new TextEncoder().encode(JSON.stringify(value)))};
  }}}});
  const api = {
    hello:async() => (await adapter.request('/v3/hello')).json(),
    snapshot:async() => (await adapter.request('/v3/snapshot')).json(),
    call:async<T>(op:string,params:unknown) => (await (await adapter.request(`/v3/ops/${op}`,{method:'POST',body:JSON.stringify(params)})).json()).result as T,
  };
  const Events = function(path:string) { return adapter.subscribeEvents(path); } as unknown as typeof EventSource;
  const store = createStore(api,Events);
  const stop = store.start();
  const settle = () => new Promise(resolve => setTimeout(resolve,0));
  try {
    await settle();
    events!.onmessage({type:'status',status:'connected'});
    expect(store.getState().connected).toBe(true);
    // Tasks reads succeed; a cached snapshot can still lag an SSE event.
    await api.call('task.list',{all:true,limit:20});
    await api.call('dispatch.list',{relation:'all',limit:100});
    healthy = false;
    await store.refresh();
    expect(store.getState().connected).toBe(false);
    events!.onmessage({type:'resync',id:10,data:'{}'});
    healthy = true;
    // Rust's stream stayed connected: successful reads and its cached status
    // must recover the store without waiting for another status broadcast.
    await store.refresh();
    await settle();
    expect(reads).toBe(2);
    expect(store.getState().connected).toBe(true);
    expect(store.getState().needsSnapshot).toBe(false);
  } finally { stop(); }
});


test('a resync arriving during a snapshot read survives until the following successful snapshot', async () => {
  class Channel { onmessage: (value: any) => void = () => {}; }
  let events: Channel | undefined;
  let finishSnapshot: ((value: unknown) => void) | undefined;
  const adapter = createDesktopPlatform({__TAURI__:{core:{Channel,invoke:async(command,args = {}) => {
    if (command === 'service_events') { events = args.channel as Channel; return; }
    return new Promise(resolve => { finishSnapshot = resolve; });
  }}}});
  const stop = adapter.subscribeDesktopConnection!(() => {});
  const reply = {status:200,body:Array.from(new TextEncoder().encode('{}'))};
  try {
    const pending = adapter.request('/v3/snapshot');
    events!.onmessage({type:'resync',id:2,data:'{}'});
    finishSnapshot!(reply);
    await pending;
    let resets = 0;
    const first = adapter.subscribeEvents('/v3/events?since=100');
    first.addEventListener('reset', () => resets++);
    await Promise.resolve();
    expect(resets).toBe(1);
    first.close();
    const next = adapter.request('/v3/snapshot');
    finishSnapshot!(reply);
    await next;
    const second = adapter.subscribeEvents('/v3/events?since=2');
    second.addEventListener('reset', () => resets++);
    await Promise.resolve();
    expect(resets).toBe(1);
    second.close();
  } finally { stop(); }
});
