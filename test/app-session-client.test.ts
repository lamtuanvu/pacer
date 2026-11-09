import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { SessionClient, type SessionSocket } from '../app/src/term/client';
import { SessionRuntimeRegistry } from '../app/src/term/runtime';
import { ViewerHub } from '../src/session/viewers';
import { FrameType, WireDecoder, wire } from '../src/session/framing';
class FakeSocket implements SessionSocket {
 readyState=1; binaryType='arraybuffer'; sent:(string|Uint8Array)[]=[];
 onopen:(()=>void)|null=null; onmessage:((e:{data:unknown})=>void)|null=null; onclose:(()=>void)|null=null; onerror:(()=>void)|null=null;
 send(data:string|Uint8Array){this.sent.push(data);} close(){this.readyState=3;}
 frame(data:unknown){this.onmessage?.({data:JSON.stringify(data)});}
 output(s:string){const bytes=new TextEncoder().encode(s), frame=new Uint8Array(5+bytes.length);frame[0]=3;new DataView(frame.buffer).setUint32(1,bytes.length);frame.set(bytes,5);this.onmessage?.({data:frame.buffer});}
 json(){return this.sent.filter((s):s is string=>typeof s==='string').map(s=>JSON.parse(s));}
}
function fixture(autoControl?:boolean){const sockets:FakeSocket[]=[], timers:(()=>void)[]=[], writes:string[]=[], states:string[]=[];let resets=0;
 const client=new SessionClient({url:'ws://localhost/v2/tasks/t-1/session',cols:120,rows:40,label:'app',control:true,autoControl,
 socket:()=>{const s=new FakeSocket();sockets.push(s);return s;},schedule:fn=>{timers.push(fn);return ()=>{};},
 onSnapshot:s=>{resets++;writes.push(s.scrollbackAnsi,s.screenAnsi);},onOutput:b=>writes.push(new TextDecoder().decode(b)),onState:s=>states.push(s.status)});
 client.connect();sockets[0]!.onopen?.();return {client,sockets,timers,writes,states,resets:()=>resets};}
test('opening an active task claims an unheld session once without taking another viewer\'s control',()=>{
 const free=fixture(),socket=free.sockets[0]!;
 socket.frame({type:'snapshot',outputOffset:0,cols:120,rows:40,scrollbackAnsi:'',screenAnsi:'',controller:null,viewers:1});
 // A host always follows the snapshot with a control frame; it names the host's version before any take.
 expect(socket.json().filter(frame=>frame.type==='take')).toEqual([]);
 socket.frame({type:'control',controller:null,you:false,versions:[1,1],pacer:'0.13.0'});
 expect(socket.json().filter(frame=>frame.type==='take')).toEqual([{type:'take'}]);
 socket.frame({type:'control',controller:'app',you:true});free.client.release();
 socket.frame({type:'control',controller:null,you:false});
 expect(socket.json().filter(frame=>frame.type==='take')).toHaveLength(1);
 free.client.dispose();
 const held=fixture(true),other=held.sockets[0]!;
 other.frame({type:'snapshot',outputOffset:0,cols:120,rows:40,scrollbackAnsi:'',screenAnsi:'',controller:'cli',viewers:2});
 other.frame({type:'control',controller:'cli',you:false});
 expect(other.json().filter(frame=>frame.type==='take')).toEqual([]);
 held.client.dispose();
});
test('snapshot precedes output, byte offsets resume after a drop and resync replaces screen',()=>{const f=fixture(false),s=f.sockets[0]!;
 expect(s.json()[0]).toEqual({type:'hello',v:1,versions:[1,2],client:'app',label:'app',cols:120,rows:40});
 s.frame({type:'snapshot',outputOffset:20,cols:80,rows:24,scrollbackAnsi:'old',screenAnsi:'screen',controller:null,viewers:1});s.output('é');
 expect(f.writes).toEqual(['old','screen','é']);s.onclose?.();f.timers[0]!();f.sockets[1]!.onopen?.();expect(f.sockets[1]!.json()[0].from).toBe(22);
 f.sockets[1]!.frame({type:'resync'});f.sockets[1]!.frame({type:'snapshot',outputOffset:50,cols:80,rows:24,scrollbackAnsi:'fresh',screenAnsi:'screen',controller:null,viewers:1});expect(f.resets()).toBe(2);f.client.dispose();});
test('control can be requested explicitly, force requires confirmation, release immediately drops input, exit stops reconnecting',async()=>{const f=fixture(false),s=f.sockets[0]!;
 s.frame({type:'snapshot',outputOffset:0,cols:120,rows:40,scrollbackAnsi:'',screenAnsi:'',controller:null,viewers:1});
 expect(f.client.input('no')).toBe(false);expect(f.client.resize(80,24)).toBe(false);await f.client.take();expect(s.json().at(-1)).toEqual({type:'take'});
 s.frame({type:'control',controller:'someone',you:false});await f.client.take(async()=>false);expect(s.json().filter(x=>x.type==='take')).toHaveLength(1);
 await f.client.take(async()=>true);expect(s.json().at(-1)).toEqual({type:'take',force:true});
 s.frame({type:'control',controller:'app',you:true});expect(f.client.input('x')).toBe(true);expect((s.sent.at(-1) as Uint8Array)[0]).toBe(10);expect(f.client.resize(90,30)).toBe(true);
 f.client.release();s.frame({type:'snapshot',outputOffset:0,cols:120,rows:40,scrollbackAnsi:'',screenAnsi:'',controller:null,viewers:1});
 expect(f.client.input('no')).toBe(false);expect(s.json().at(-1)).toEqual({type:'release'});
 s.frame({type:'exit',code:0});s.onclose?.();expect(f.timers).toHaveLength(0);expect(f.states.at(-1)).toBe('exited');f.client.dispose();});
test('capabilities.control false refuses take and input even if server grants control',async()=>{const s=new FakeSocket();const c=new SessionClient({url:'ws://localhost',cols:80,rows:24,label:'viewer',control:false,socket:()=>s});c.connect();s.onopen?.();s.frame({type:'control',you:true,controller:'viewer'});await c.take();expect(c.input('x')).toBe(false);expect(s.json()).toHaveLength(1);c.dispose();});
test('empty resume becomes live on control frame; subsequent output preserves offset',()=>{const f=fixture(false),s=f.sockets[0]!;s.frame({type:'snapshot',outputOffset:12,cols:80,rows:24,scrollbackAnsi:'',screenAnsi:'',controller:null,viewers:1});s.onclose?.();f.timers[0]!();const resumed=f.sockets[1]!;resumed.onopen?.();resumed.frame({type:'control',you:false,controller:null});expect(f.client.state.status).toBe('live');resumed.output('next');expect(f.writes.at(-1)).toBe('next');resumed.onclose?.();f.timers[1]!();f.sockets[2]!.onopen?.();expect(f.sockets[2]!.json()[0].from).toBe(16);f.client.dispose();});
test('losing control and a network drop immediately disable input',()=>{const f=fixture(false),s=f.sockets[0]!;s.frame({type:'control',you:true,controller:'app'});expect(f.client.input('a')).toBe(true);s.frame({type:'control',you:false,controller:'cli',reason:'taken'});expect(f.client.input('b')).toBe(false);expect(f.client.state.message).toContain('taken');s.frame({type:'control',you:true,controller:'app'});s.onclose?.();expect(f.client.input('c')).toBe(false);f.client.dispose();});
test('reconnect delay increases from 500 ms to 5 seconds; dispose cancels it',()=>{const sockets:FakeSocket[]=[],delays:number[]=[],pending:(()=>void)[]=[];let cancelled=false;const c=new SessionClient({url:'ws://localhost',label:'app',cols:80,rows:24,control:false,socket:()=>{const s=new FakeSocket();sockets.push(s);return s;},schedule:(fn,ms)=>{delays.push(ms);pending.push(fn);return ()=>{cancelled=true;};}});c.connect();for(let i=0;i<6;i++){sockets[i]!.onclose?.();pending[i]!();}expect(delays).toEqual([500,1000,2000,4000,5000,5000]);c.dispose();expect(cancelled).toBe(true);});

test('an empty reconnect resume reclaims only an available lease and handback suppresses it', () => {
 const f=fixture(),s=f.sockets[0]!;
 s.frame({type:'snapshot',outputOffset:12,cols:80,rows:24,scrollbackAnsi:'history',screenAnsi:'prompt',controller:null,viewers:1});
 s.frame({type:'control',controller:'app',you:true});s.onclose?.();f.timers[0]!();
 const resumed=f.sockets[1]!;resumed.onopen?.();resumed.frame({type:'control',controller:null,you:false});
 expect(resumed.json().filter(frame=>frame.type==='take')).toEqual([{type:'take'}]);
 resumed.frame({type:'control',controller:'app',you:true});f.client.release();resumed.onclose?.();f.timers[1]!();
 const handedBack=f.sockets[2]!;handedBack.onopen?.();handedBack.frame({type:'control',controller:null,you:false});
 expect(handedBack.json().filter(frame=>frame.type==='take')).toEqual([]);f.client.dispose();
});

test('an explicit take restores reconnect intent after a deliberately read-only attach or handback', async () => {
 const f=fixture(false),s=f.sockets[0]!;
 s.frame({type:'snapshot',outputOffset:0,cols:80,rows:24,scrollbackAnsi:'',screenAnsi:'prompt',controller:null,viewers:1});
 await f.client.take();s.frame({type:'control',controller:'app',you:true});f.client.release();
 s.frame({type:'control',controller:null,you:false});
 await f.client.take();s.frame({type:'control',controller:'app',you:true});s.onclose?.();f.timers[0]!();
 const resumed=f.sockets[1]!;resumed.onopen?.();resumed.frame({type:'control',controller:null,you:false});
 expect(resumed.json().filter(frame=>frame.type==='take')).toEqual([{type:'take'}]);f.client.dispose();
});

const shared={type:'control',controller:null,you:true,versions:[1,2],pacer:'0.14.0'};
const live={type:'snapshot',outputOffset:0,cols:120,rows:40,scrollbackAnsi:'',screenAnsi:'',controller:null,viewers:2};
const sentInput=(s:FakeSocket)=>s.sent.filter((frame):frame is Uint8Array=>typeof frame!=='string').map(frame=>frame[0]);
test('a 1.2 host types without take, sends focus and size, and never sends take or release', async () => {
 const f=fixture(),s=f.sockets[0]!;
 s.frame(live);s.frame(shared);
 expect(f.client.state).toMatchObject({status:'live',you:true,shared:true,controller:null});
 expect(f.client.input('x')).toBe(true);expect(sentInput(s)).toEqual([10]);
 expect(f.client.focus()).toBe(true);expect(s.json().at(-1)).toEqual({type:'focus'});
 expect(f.client.resize(100,30)).toBe(true);expect(s.json().at(-1)).toEqual({type:'size',cols:100,rows:30});
 expect(await f.client.take(async()=>true)).toBe(false);expect(f.client.release()).toBe(false);
 expect(f.client.state.you).toBe(true);
 expect(s.json().filter(frame=>['take','release'].includes(frame.type))).toEqual([]);
 f.client.dispose();
});
test('a 1.2 pane opened before the task was live becomes interactive when it goes live, and read-only again when it ends', () => {
 // The desktop keeps a pane's connection across navigation: it may connect while the task is still queued.
 const sockets:FakeSocket[]=[];
 const client=new SessionClient({url:'ws://localhost/v2/tasks/t-1/session',cols:120,rows:40,label:'app',control:false,
  socket:()=>{const s=new FakeSocket();sockets.push(s);return s;},schedule:()=>()=>{}});
 client.connect();const s=sockets[0]!;s.onopen?.();
 s.frame(live);s.frame(shared);
 expect(client.state).toMatchObject({shared:true,you:false});
 client.configure(true);
 expect(client.state.you).toBe(true);
 expect(client.input('x')).toBe(true);
 client.configure(false);
 expect(client.state.you).toBe(false);
 expect(client.input('y')).toBe(false);
 expect(s.json().filter(frame=>['take','release'].includes(frame.type))).toEqual([]);
 client.dispose();
});
test('a 1.2 reconnect keeps take off and sends focus only after the host answers', async () => {
 const f=fixture(),s=f.sockets[0]!;
 s.frame(live);s.frame(shared);s.onclose?.();f.timers[0]!();
 const resumed=f.sockets[1]!;resumed.onopen?.();
 expect(f.client.focus()).toBe(false);expect(await f.client.take()).toBe(false);
 resumed.frame(shared);
 expect(f.client.focus()).toBe(true);
 expect(resumed.json().map(frame=>frame.type)).toEqual(['hello','focus']);
 // A later control frame has no versions; the connection stays on 1.2.
 resumed.frame({type:'control',controller:null,you:true,reason:'released'});
 expect(f.client.state.shared).toBe(true);expect(f.client.state.message).toBeUndefined();
 f.client.dispose();
});
test('a 1.1 host keeps take and release and never receives 1.2 frames', async () => {
 const f=fixture(),s=f.sockets[0]!;
 s.frame(live);s.frame({type:'control',controller:null,you:false,versions:[1,1],pacer:'0.13.0'});
 expect(f.client.state.shared).toBe(false);
 expect(s.json().filter(frame=>frame.type==='take')).toEqual([{type:'take'}]);
 s.frame({type:'control',controller:'app',you:true});
 expect(f.client.focus()).toBe(false);expect(f.client.input('x')).toBe(true);
 expect(f.client.release()).toBe(true);expect(s.json().at(-1)).toEqual({type:'release'});
 s.frame({type:'control',controller:'cli',you:false});
 expect(await f.client.take(async message=>{expect(message).toBe('Someone is in control from cli. Take over?');return true;})).toBe(true);
 expect(s.json().at(-1)).toEqual({type:'take',force:true});
 expect(s.json().some(frame=>frame.type==='focus')).toBe(false);
 f.client.dispose();
});
test('the hello range matches the session protocol and a host range decides the minor', async () => {
 const {SESSION_PROTOCOL}=await import('../src/session/protocol');
 const {SESSION_VERSIONS,negotiatedMinor}=await import('../app/src/term/client');
 expect([...SESSION_VERSIONS]).toEqual([...SESSION_PROTOCOL]);
 expect(negotiatedMinor(undefined)).toBe(1);expect(negotiatedMinor([1,1])).toBe(1);
 expect(negotiatedMinor([1,2])).toBe(2);expect(negotiatedMinor([1,5])).toBe(2);expect(negotiatedMinor('bad')).toBe(1);
});
test('a 1.2 host names pacer deliveries until this pane types, and a 1.1 host never shows them', () => {
 const f=fixture(),s=f.sockets[0]!;
 s.frame(live);s.frame(shared);
 s.frame({type:'granted'});expect(f.client.state.status).toBe('live');
 s.frame({type:'delivered',ok:true,label:'pacer answer'});
 expect(f.client.state.delivered).toEqual({kind:'answer',label:'pacer answer'});
 s.frame({type:'delivered',ok:true,kind:'message',label:'pacer'});
 expect(f.client.state.delivered).toEqual({kind:'message',label:'pacer'});
 s.frame({type:'delivered',ok:false,label:'pacer answer'});expect(f.client.state.delivered?.kind).toBe('message');
 f.client.input('x');expect(f.client.state.delivered).toBeUndefined();
 f.client.dispose();
 const old=fixture(false),o=old.sockets[0]!;
 o.frame(live);o.frame({type:'control',controller:null,you:false,versions:[1,1]});
 o.frame({type:'delivered',ok:true,label:'pacer answer'});expect(old.client.state.delivered).toBeUndefined();
 old.client.dispose();
});
test('an app window gets a distinguishable viewer label only among windows of the same kind', async () => {
 const { announceViewerWindow, viewerPlatformName, viewerWindowLabel } = await import('../app/src/term/runtime');
 const map = new Map<string, string>();
 const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
 expect(viewerPlatformName(true)).toBe('Pacer desktop');
 expect(viewerPlatformName(false)).toBe('Browser');
 // The first window of a kind keeps the plain platform name; a second gets a short ordinal.
 const first = announceViewerWindow(false, storage);
 const second = announceViewerWindow(false, storage);
 expect(first.label).toBe('Browser');
 expect(second.label).toBe('Browser · 2');
 // A desktop window shares no counter with browser windows, and a lone one needs no suffix.
 expect(announceViewerWindow(true, storage).label).toBe('Pacer desktop');
 // Releasing the second window frees its ordinal; the next window reuses it and stays distinct.
 second.release();
 expect(announceViewerWindow(false, storage).label).toBe('Browser · 2');
 // In a bare test context (no desktop host, no storage) the window labels itself as a browser.
 expect(viewerWindowLabel()).toBe('Browser');
});
test('two windows opened in the same instant that land on the same ordinal still get distinct labels', async () => {
 // A storage whose reads lag behind writes models two tabs racing: both windows read the store as
 // holding only window 1 (so both pick ordinal 2), and each then sees the other's same-ordinal
 // lease at its post-write recheck, so both append a unique tiebreak and never collide.
 const seed = JSON.stringify([{ n: 1, id: 'window-one' }]);
 const bothWrote = JSON.stringify([{ n: 1, id: 'window-one' }, { n: 2, id: 'window-A' }, { n: 2, id: 'window-B' }]);
 let reads = 0;
 const storage = {
  getItem: () => { reads++; return reads === 1 || reads === 3 ? seed : bothWrote; },
  setItem: () => {},
 };
 const runtime = await import('../app/src/term/runtime');
 const a = runtime.announceViewerWindow(false, storage);
 const b = runtime.announceViewerWindow(false, storage);
 expect(a.label).toMatch(/^Browser · 2·/);
 expect(b.label).toMatch(/^Browser · 2·/);
 expect(a.label).not.toBe(b.label);
});
test('a later update without a label never overwrites the window\'s viewer label', () => {
 const sockets: RuntimeSocket[] = [], urls: string[] = [], timers: (() => void)[] = [];
 const registry = new SessionRuntimeRegistry({
  maxRuntimes: 8, maxBytes: 1024 * 1024,
  socket: (url) => { urls.push(url); const s = new RuntimeSocket(); sockets.push(s); return s; },
  schedule: (fn) => { timers.push(fn); return () => {}; },
 });
 const r = registry.get('service', 'task:one', { url: 'ws://localhost/v3/tasks/one/session', cols: 80, rows: 24, label: 'Browser', control: true, autoControl: false });
 r.attach({ reset: () => {}, write: () => {} });
 sockets[0]!.onopen?.();
 expect(JSON.parse(sockets[0]!.sent[0]!).label).toBe('Browser');
 // A later update that omits a label must keep the window's viewer label across the reconnect.
 r.update({ attempt: 1 });
 sockets.at(-1)!.onopen?.();
 expect(JSON.parse(sockets.at(-1)!.sent[0]!).label).toBe('Browser');
 // An explicit caller label still wins over the window label.
 r.update({ attempt: 2, label: 'override' });
 sockets.at(-1)!.onopen?.();
 expect(JSON.parse(sockets.at(-1)!.sent[0]!).label).toBe('override');
 registry.dispose();
});
class RuntimeSocket implements SessionSocket {
 readyState = 1; binaryType = 'arraybuffer'; sent: string[] = [];
 onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
 onmessage: ((e: { data: unknown }) => void) | null = null;
 send(data: string | Uint8Array) { if (typeof data === 'string') this.sent.push(data); }
 close() { this.readyState = 3; }
}
test('with two app windows on one session, typing in window 2 tells window 1 who typed last', async () => {
 class Peer extends EventEmitter {
  destroyed = false; writableLength = 0; frames: Buffer[] = []; blocked = false;
  write(b: Buffer) { this.frames.push(b); return !this.blocked; }
  end(b: Buffer, cb?: () => void) { this.write(b); this.destroyed = true; cb?.(); }
  destroy() { this.destroyed = true; this.emit('close'); }
 }
 const modern = [1, 2] as [number, number];
 const inputs: string[] = [];
 const hub = new ViewerHub(() => wire(FrameType.snapshot, { controller: null, active: hub.active }), () => null, (fn) => fn(), () => {}, () => {},
  { input: (b) => { inputs.push(b.toString()); }, resize: () => {} }, { pacer: '0.14.0', versions: modern });
 const attach = (label: string) => { const p = new Peer(); hub.add(p as never); p.emit('data', wire(FrameType.hello, { v: 1, client: 'app', label, versions: modern })); return p; };
 const window1 = attach('Browser'); const window2 = attach('Browser · 2');
 window2.emit('data', wire(FrameType.input, Buffer.from('ls\r')));
 expect(hub.active).toBe('app:Browser · 2');
 expect(inputs).toEqual(['ls\r']);
 // The host broadcasts the new active to every 1.2 viewer, so window 1 learns window 2's label.
 const sent = window1.frames.flatMap((b) => new WireDecoder().push(b));
 const control = sent.filter((f) => f.type === FrameType.control).map((f) => JSON.parse(f.data.toString()));
 expect(control.at(-1)).toMatchObject({ controller: null, active: 'app:Browser · 2', you: true });
 // window 1 then renders the other window's label in its status line.
 const { lastInputWords } = await import('../app/src/term/activity');
 expect(lastInputWords(control.at(-1)!.active)).toBe('Interactive · last input from Browser · 2');
 hub.destroy();
});
test('a 1.2 host active broadcast lets a client see who typed last in another window', async () => {
 const f = fixture(), s = f.sockets[0]!;
 s.frame({ type: 'snapshot', outputOffset: 0, cols: 120, rows: 40, scrollbackAnsi: '', screenAnsi: '', controller: null, viewers: 2, active: null });
 s.frame({ type: 'control', controller: null, you: true, versions: [1, 2], pacer: '0.14.0', active: null });
 expect(f.client.state.active).toBeNull();
 // Window 2 just typed; the host broadcasts it to every viewer including this one.
 s.frame({ type: 'control', controller: null, you: true, active: 'app:Browser · 2' });
 expect(f.client.state.active).toBe('app:Browser · 2');
 const { lastInputWords } = await import('../app/src/term/activity');
 expect(lastInputWords(f.client.state.active)).toBe('Interactive · last input from Browser · 2');
 f.client.dispose();
});
