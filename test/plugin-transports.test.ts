import { test, expect } from "bun:test";
import { chooseTransport, type Transport } from "../orca-plugin/src/transports/choose";
import { emptySnapshot, type OutboxEvent } from "../src/link/envelope";
import { createPlugin, type Timers } from "../orca-plugin/src/plugin";
import type { OrcaWorkerContext } from "../orca-plugin/src/orca-api";
export class ManualTimers implements Timers {
  now = 0; jobs: { at: number; interval: number; fn: () => void; cancelled: boolean }[] = [];
  schedule(ms: number, fn: () => void, interval: number) { const j = { at: this.now + ms, interval, fn, cancelled: false }; this.jobs.push(j); return () => { j.cancelled = true; }; }
  every(ms: number, fn: () => void) { return this.schedule(ms, fn, ms); }
  after(ms: number, fn: () => void) { return this.schedule(ms, fn, 0); }
  async advance(ms: number) { const end = this.now + ms; for (;;) { const j = this.jobs.filter(j => !j.cancelled && j.at <= end).sort((a,b) => a.at-b.at)[0]; if (!j) break; this.now=j.at; if(j.interval) j.at += j.interval; else j.cancelled=true; j.fn(); await flush(); } this.now=end; await flush(); }
}
export async function flush() { for(let i=0;i<100;i++) await Promise.resolve(); }
const alert: OutboxEvent = { type:"alert", data:{ key:"a", level:"warn", title:"Alert", body:"body", at:100 } };
function stub(id: Transport["id"], up: boolean): Transport { return { id, probe:async()=>up, snapshot:async()=>null, watch:()=>()=>{} }; }
import { apiTransport } from "../orca-plugin/src/transports/api";
import type { ApiClient } from "../src/api/client-types";
import type { ApiEvent } from "../src/api/protocol";
import { readSettings } from "../orca-plugin/src/settings";

function fakeClient(over: Partial<ApiClient> = {}) {
 let handler: ((e: ApiEvent) => void) | null = null;
 const c = {
  kind: "http" as const, snapshots: 0, since: -1,
  hello: async () => ({ protocol: "2.0.0", pacer: "0", ops: [], events: [] }),
  snapshot: async () => { c.snapshots++; return { protocol: "2.0.0", seq: 5, snapshot: { ...emptySnapshot(), seq: 5 } }; },
  call: async <T = unknown>() => null as T,
  subscribe: (since: number, on: (e: ApiEvent) => void) => { c.since = since; handler = on; return () => { handler = null; }; },
  close() {}, emit: (e: ApiEvent) => handler?.(e), ...over,
 };
 return c;
}

test("api transport forwards valid events as envelopes from the snapshot seq", async () => {
 const client = fakeClient(), got: OutboxEvent[] = [], timers = new ManualTimers(); let connections = 0;
 const t = apiTransport({ connect: async () => { connections++; return client; }, timers });
 expect(await t.probe()).toBe(true);
 const stop = t.watch(e => got.push(e), () => {}); await flush();
 expect(client.since).toBe(5); expect(connections).toBe(1);
 client.emit({ seq: 6, at: 0, type: "alert", data: alert.data });
 client.emit({ seq: 7, at: 0, type: "alert", data: null });
 client.emit({ seq: 8, at: 0, type: "host", data: {} } as unknown as ApiEvent);
 stop(); client.emit({ seq: 9, at: 0, type: "alert", data: alert.data });
 expect(got).toEqual([alert]);
});

test("reset re-fetches the snapshot", async () => {
 const client = fakeClient(), timers = new ManualTimers(); let snaps = 0;
 const t = apiTransport({ connect: async () => client, timers });
 const stop = t.watch(() => {}, () => { snaps++; }); await flush();
 const before = client.snapshots, delivered = snaps;
 client.emit({ seq: 7, at: 0, type: "reset", data: {} }); await flush();
 expect(client.snapshots).toBeGreaterThan(before); expect(snaps).toBeGreaterThan(delivered); stop();
});

test("api transport polls snapshots, reports failures and stops cleanly", async () => {
 let fail = false, snaps = 0, failures = 0;
 const client = fakeClient({ snapshot: async () => { if (fail) throw Error("offline"); return { protocol: "2.0.0", seq: 5, snapshot: emptySnapshot() }; } });
 const timers = new ManualTimers(), t = apiTransport({ connect: async () => client, timers });
 const stop = t.watch(() => {}, () => snaps++, () => failures++); await flush();
 const before = snaps; await timers.advance(10000); expect(snaps).toBe(before + 1);
 fail = true; await timers.advance(10000); expect(failures).toBe(1); expect(await t.snapshot()).toBeNull();
 stop(); await timers.advance(20000); expect(failures).toBe(1);
});

test("api transport probes false when pacer cannot start", async () => {
 const timers = new ManualTimers();
 expect(await apiTransport({ connect: async () => null, timers }).probe()).toBe(false);
 for (const connect of [async () => fakeClient({ hello: () => new Promise<never>(() => {}) }), () => new Promise<never>(() => {})]) {
  let result: boolean | undefined;
  void apiTransport({ connect, timers }).probe().then(v => { result = v; }); await flush();
  await timers.advance(1999); expect(result).toBeUndefined(); await timers.advance(1); expect(result).toBe(false);
 }
});

test("auto uses only API and reports unavailable when it cannot connect", async () => {
 for (const available of [true,false]) {
  const r=await chooseTransport([stub("api",available)],"auto");
  expect(r.transport?.id??null).toBe(available?"api":null);
  expect(r.reachable).toBe(available);
 }
});

test("reset during a snapshot fetch queues another fetch", async () => {
 const client = fakeClient(), timers = new ManualTimers();
 const t = apiTransport({ connect: async () => client, timers });
 const stop = t.watch(() => {}, () => {}); await flush();
 let release!: () => void, calls = 0;
 client.snapshot = async () => {
  calls++;
  if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
  return { protocol: "2.0.0", seq: 7, snapshot: emptySnapshot() };
 };
 await timers.advance(10000);
 client.emit({ seq: 7, at: 0, type: "reset", data: {} });
 release(); await flush();
 expect(calls).toBe(2); stop();
});

for (const timeout of [false, true]) test(`failed probe preserves a watched API client (timeout ${timeout})`, async () => {
 let closes = 0, connections = 0;
 const client = fakeClient({ close: () => { closes++; } });
 const timers = new ManualTimers(), got: OutboxEvent[] = [];
 const t = apiTransport({ connect: async () => { connections++; return client; }, timers });
 const stop = t.watch(e => got.push(e), () => {}); await flush();
 client.hello = timeout ? () => new Promise<never>(() => {}) : async () => { throw Error("offline"); };
 const probing = t.probe(); await flush();
 if (timeout) await timers.advance(2000);
 expect(await probing).toBe(false); await flush();
 expect(closes).toBe(0);
 client.emit({ seq: 6, at: 0, type: "alert", data: alert.data });
 expect(got).toEqual([alert]);
 expect(await t.snapshot()).not.toBeNull();expect(connections).toBe(1);stop();
});

test("a failed client created by a probe is closed and replaced", async () => {
 let closes = 0, connections = 0;
 const failed = fakeClient({ hello: async () => { throw Error("offline"); }, close: () => { closes++; } });
 const good = fakeClient(), timers = new ManualTimers();
 const t = apiTransport({ connect: async () => ++connections === 1 ? failed : good, timers });
 expect(await t.probe()).toBe(false); await flush();expect(closes).toBe(1);
 expect(await t.probe()).toBe(true);expect(connections).toBe(2);
});

for (const fails of [false, true]) test(`plugin owns API client lifecycle (failed probe ${fails})`, async () => {
 const timers = new ManualTimers();let hellos = 0, closes = 0;
 const client = fakeClient({ hello: async () => {
   hellos++;if (fails) throw Error("offline");
   return { protocol: "2.0.0", pacer: "0", ops: [], events: [] };
 }, close: () => { closes++; } });
 const plugin = createPlugin({ connect: async () => client, timers, nowS: () => timers.now / 1000,
   home: "/tmp/plugin-fixture", pluginRoot: "/tmp/plugin-fixture",
   fs: { exists: () => true, readText: () => null, writeTextAtomic() {} },
   http: { get: async () => ({ status: 401, body: "" }), stream: () => () => {} },
 });
 const ctx = { host: { call: async (method: string) => method === "settings.get" ? { settings: { autoConsole: false } } : { value: null } },
   commands: { register() {} }, events: { on() {} }, log() {} } as unknown as OrcaWorkerContext;
 try {
   await plugin.activate(ctx);await flush();
   if (!fails) { await timers.advance(30000);expect(hellos).toBe(1);expect(closes).toBe(0); }
   else expect(closes).toBe(1);
 } finally { await plugin.deactivate(); }
 expect(closes).toBe(1);
});

test("API worker registers and renews its notifier, delivering only targeted service notifications", async()=>{
 const timers=new ManualTimers(),calls:{op:string;params:unknown}[]=[],shown:unknown[]=[];
 const client=fakeClient({hello:async()=>({protocol:"2.6.0",pacer:"1",ops:["client.register","client.heartbeat"],events:["notify"]}),call:async<T>(op:string,params:unknown)=>{calls.push({op,params});return (op==="client.register"?{client_id:"orca-1",lease_s:30}:{ok:true}) as T;}});
 const originalSnapshot=client.snapshot;
 client.snapshot=async()=>{const result=await originalSnapshot();result.snapshot.alerts=[{key:"legacy",at:1,level:"warn",title:"Legacy alert",body:"body",notification:{kind:"failed",fromPanel:true}}];return result;};
 const plugin=createPlugin({connect:async()=>client,timers,nowS:()=>timers.now/1000,version:"1",home:"/tmp/plugin-fixture",pluginRoot:"/tmp/plugin-fixture",fs:{exists:()=>true,readText:()=>null,writeTextAtomic(){}},http:{get:async()=>({status:401,body:""}),stream:()=>()=>{}}});
 const ctx={host:{call:async(method:string,params:unknown)=>{if(method==="notifications.show"){shown.push(params);return {delivered:true};}return method==="settings.get"?{settings:{transport:"api",notifications:"all"}}:{value:null};}},commands:{register(){}},events:{on(){}},log(){}} as unknown as OrcaWorkerContext;
 try{
  await plugin.activate(ctx);await flush();
  expect(calls).toContainEqual({op:"client.register",params:{kind:"orca",version:"1",notifier:true}});
  const data={key:"k",title:"Needs you",body:"Review",actions:[],url:"/app/#tasks/t",client_id:"another"};
  client.emit({seq:6,at:0,type:"notify",data});await flush();expect(shown).toEqual([]);
  client.emit({seq:7,at:0,type:"notify",data:{...data,client_id:"orca-1"}});await flush();
  client.emit({seq:8,at:0,type:"notify",data:{...data,client_id:"orca-1",key:"second"}});await flush();
  expect(shown).toEqual([{title:"Needs you",body:"Review"},{title:"Needs you",body:"Review"}]);
  client.emit({seq:9,at:0,type:"notify",data:{...data,client_id:"orca-1"}});await flush();expect(shown).toHaveLength(2);
  await timers.advance(30000);
  expect(calls).toContainEqual({op:"client.heartbeat",params:{client_id:"orca-1"}});
  expect(shown).toHaveLength(2);
 }finally{await plugin.deactivate();}
 const count=calls.length;await timers.advance(60000);expect(calls).toHaveLength(count);
});

test("worker with no API renders the update notice and never reads link storage",async()=>{
 const timers=new ManualTimers(),pages:string[]=[],calls:string[]=[];
 const plugin=createPlugin({connect:async()=>null,nowS:()=>timers.now/1000,timers,home:"/tmp/plugin-fixture",pluginRoot:"/tmp/plugin-fixture",fs:{exists:()=>true,readText:()=>null,writeTextAtomic:(_path,text)=>pages.push(text)},http:{get:async()=>({status:401,body:""}),stream:()=>()=>{}}});
 const ctx={host:{call:async(method:string)=>{calls.push(method);return {settings:{}};}},commands:{register(){}},events:{on(){}},log(){}} as unknown as OrcaWorkerContext;
 try{
  await plugin.activate(ctx);await flush();await timers.advance(2000);
  expect(pages.at(-1)).toContain("Update the pacer plugin");
  expect(pages.at(-1)).toContain("pacer update");
  expect(calls).not.toContain("storage.get");
 }finally{await plugin.deactivate();}
 expect(timers.jobs.filter(j=>!j.cancelled)).toEqual([]);
});
