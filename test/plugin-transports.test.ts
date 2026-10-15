import { test, expect } from "bun:test";
import { chooseTransport, type Transport } from "../orca-plugin/src/transports/choose";
import { httpTransport, type HttpPort } from "../orca-plugin/src/transports/http";
import { bridgeTransport } from "../orca-plugin/src/transports/bridge";
import { channelTransport } from "../orca-plugin/src/transports/channel";
import { LinkStore } from "../orca-plugin/src/store";
import { emptySnapshot, contentKey, reduce, type Envelope } from "../src/link/envelope";
import type { Timers } from "../orca-plugin/src/plugin";
import type { OrcaHost } from "../orca-plugin/src/orca-api";
export class ManualTimers implements Timers {
  now = 0; jobs: { at: number; interval: number; fn: () => void; cancelled: boolean }[] = [];
  schedule(ms: number, fn: () => void, interval: number) { const j = { at: this.now + ms, interval, fn, cancelled: false }; this.jobs.push(j); return () => { j.cancelled = true; }; }
  every(ms: number, fn: () => void) { return this.schedule(ms, fn, ms); }
  after(ms: number, fn: () => void) { return this.schedule(ms, fn, 0); }
  async advance(ms: number) { const end = this.now + ms; for (;;) { const j = this.jobs.filter(j => !j.cancelled && j.at <= end).sort((a,b) => a.at-b.at)[0]; if (!j) break; this.now=j.at; if(j.interval) j.at += j.interval; else j.cancelled=true; j.fn(); await flush(); } this.now=end; await flush(); }
}
export async function flush() { for(let i=0;i<100;i++) await Promise.resolve(); }
const alert: Envelope = { v:1, type:"alert", data:{ key:"a", level:"warn", title:"Alert", body:"body", at:100 } };
function stub(id: Transport["id"], up: boolean): Transport { return { id, probe:async()=>up, snapshot:async()=>null, watch:()=>()=>{} }; }
for (const [up, forced, id, reachable] of [
  [[true,true,true],"auto","http",true], [[false,true,true],"auto","channel",true], [[false,false,true],"auto","bridge",true], [[false,false,false],"auto",null,false], [[true,true,true],"bridge","bridge",true], [[false,true,true],"http","http",false],
] as const) test(`choose ${up} forced ${forced}`, async()=> { const r=await chooseTransport([stub("bridge",up[2]),stub("channel",up[1]),stub("http",up[0])],forced); expect(r.transport?.id??null).toBe(id); expect(r.reachable).toBe(reachable); });
test("HTTP probe rejects missing token, 401 and a pending request at 1500ms",async()=> {
 const timers=new ManualTimers(); let token:string|null=null; let pending=false;
 const http:HttpPort={get:async()=>pending?await new Promise(()=>{}):{status:401,body:""},stream:()=>()=>{}};
 const t=httpTransport({http,readToken:()=>token,port:4317,timers}); expect(await t.probe()).toBe(false); token="t"; expect(await t.probe()).toBe(false);
 pending=true; let result:boolean|undefined; void t.probe().then(v=>result=v); await flush(); await timers.advance(1499); expect(result).toBeUndefined(); await timers.advance(1); expect(result).toBe(false);
});
test("HTTP parses SSE, reconnects with 2/4s backoff, rereads token and refreshes snapshots",async()=> {
 const timers=new ManualTimers(); let token="first"; let line!:(s:string)=>void, close!:(e?:Error)=>void; const tokens:string[]=[]; let stopped=0; let gets=0;
 const http:HttpPort={get:async(url,t,ms)=> { expect(["http://127.0.0.1:4317/link","http://127.0.0.1:4317/health"]).toContain(url); expect(ms).toBe(1500); if(url.endsWith("/link")) gets++; return {status:200,headers:{"x-pacer":"1"},body:JSON.stringify(emptySnapshot())}; },stream:(url,t,l,c)=>{expect(url).toBe("http://127.0.0.1:4317/events"); tokens.push(t);line=l;close=c;return()=>{stopped++;};}};
 const t=httpTransport({http,readToken:()=>token,port:4317,timers}); expect(await t.probe()).toBe(true); expect(await t.snapshot()).toEqual(emptySnapshot());
 const seen:Envelope[]=[]; let snapshots=0;const stop=t.watch(e=>seen.push(e),()=>snapshots++);await flush();
 line(": keepalive"); line("data: nope");line('data: {"v":1,"type":"unknown"}');line(`data: ${JSON.stringify(alert)}\n\n`);expect(seen).toEqual([alert]);
 close();token="second";await timers.advance(1999);expect(tokens).toEqual(["first"]);await timers.advance(1);expect(tokens).toEqual(["first","second"]);close();await timers.advance(3999);expect(tokens.length).toBe(2);await timers.advance(1);expect(tokens.length).toBe(3);
 await timers.advance(4000);expect(snapshots).toBe(1);expect(gets).toBe(3);stop();await timers.advance(60000);expect(snapshots).toBe(1);expect(stopped).toBeGreaterThan(0);
});
test("bridge only emits changed content and tolerates storage rejection",async()=> {
 const timers=new ManualTimers();let s=emptySnapshot();let reject=false;
 const host={call:async(m:string,p:any)=>{expect(m).toBe("storage.get");expect(p).toEqual({key:"link"});if(reject)throw Error("denied");return {value:s};}} as OrcaHost;
 const t=bridgeTransport({host,pollMs:5000,timers});expect(await t.probe()).toBe(true);const seen:any[]=[];const stop=t.watch(()=>{},x=>seen.push(x));await timers.advance(5000);expect(seen.length).toBe(1);s={...s,seq:2,at:2};await timers.advance(5000);expect(seen.length).toBe(1);s=reduce(s,alert,100);await timers.advance(5000);expect(seen.length).toBe(2);reject=true;await timers.advance(5000);expect(seen.length).toBe(2);stop();
});
test("channel probe handles unavailable API and validates data payload",async()=> {
 let reject=true;let handler!:(p:unknown)=>void;
 const host={call:async(m:string,p:any)=>{expect(m).toBe("events.subscribe");expect(p).toEqual({events:["plugin.message"]});if(reject)throw Error("zod invalid enum");return {subscribed:[]};}} as OrcaHost;
 const t=channelTransport({host,registerEvent:(name,h)=>{expect(name).toBe("plugin.message");handler=h;}});expect(await t.probe()).toBe(false);reject=false;expect(await t.probe()).toBe(true);expect(await t.snapshot()).toBeNull();const seen:Envelope[]=[];const stop=t.watch(e=>seen.push(e),()=>{});handler({data:alert});handler({data:{v:1,type:"bad"}});expect(seen).toEqual([alert]);stop();handler({data:alert});expect(seen.length).toBe(1);
});
test("store contract converges with brain reduction and ignores metadata-only changes",()=> {
 const store=new LinkStore(()=>100);let calls=0;store.onChange(()=>calls++);
 const es:Envelope[]=[{v:1,type:"budget",data:{generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:[],ranked:[]}},...(["running","done"].map(state=>({v:1 as const,type:"task" as const,data:{id:"t",state,goal:"goal",executor:"e",backend:null,worktree:null,updatedAt:100}}))),alert];
 let brain=emptySnapshot();for(const e of es){store.apply(e);brain=reduce(brain,e,100);}expect(contentKey(store.snapshot)).toBe(contentKey(brain));expect(calls).toBe(4);store.replace({...brain,seq:99,at:200});expect(calls).toBe(4);const other=new LinkStore(()=>100);other.replace(brain);expect(contentKey(other.snapshot)).toBe(contentKey(store.snapshot));
});

test("channel registers only after a successful probe and tolerates registration rejection", async () => {
 let registrations=0,allow=false;
 const host={call:async()=>{if(!allow)throw Error("unsupported");return {subscribed:[]};}} as OrcaHost;
 const t=channelTransport({host,registerEvent:()=>{registrations++;throw Error("unknown event");}});
 expect(registrations).toBe(0);expect(await t.probe()).toBe(false);expect(registrations).toBe(0);
 allow=true;expect(await t.probe()).toBe(false);expect(registrations).toBe(1);
});

test("HTTP never discloses token to an unidentified server including SSE reconnect",async()=>{
 const timers=new ManualTimers();const requests:{url:string;token:string}[]=[];let identified=false,streams=0;let close!:()=>void;
 const t=httpTransport({timers,port:4317,readToken:()=>"secret",http:{
  get:async(url,token)=>{requests.push({url,token});return {status:200,body:JSON.stringify(emptySnapshot()),headers:identified?{"x-pacer":"1"}:{}};},
  stream:(_u,_t,_l,c)=>{streams++;close=c;return()=>{};}
 }});
 expect(await t.probe()).toBe(false);expect(requests.every(r=>r.url.endsWith("/health") && !r.token)).toBe(true);
 identified=true;expect(await t.probe()).toBe(true);
 const stop=t.watch(()=>{},()=>{});await flush();expect(streams).toBe(1);
 identified=false;requests.length=0;close();await timers.advance(2000);
 expect(streams).toBe(1);expect(requests.every(r=>r.url.endsWith("/health") && !r.token)).toBe(true);stop();
});

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
 const client = fakeClient(), got: Envelope[] = [], timers = new ManualTimers(); let connections = 0;
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

test("auto prefers api and falls back through existing transports", async () => {
 for (const available of [true, false]) {
  const r = await chooseTransport([stub("bridge", true), stub("http", true), stub("api", available)], "auto");
  expect(r.transport?.id).toBe(available ? "api" : "http");
 }
 expect(readSettings({ transport: "api" }, "").transport).toBe("api");
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
