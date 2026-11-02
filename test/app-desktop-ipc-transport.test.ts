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
