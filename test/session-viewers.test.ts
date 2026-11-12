import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { DELIVERY_TIMING, ViewerHub, type DeliveryTiming } from '../src/session/viewers';
import { FrameType, WireDecoder, wire } from '../src/session/framing';
class Peer extends EventEmitter {
  destroyed=false; writableLength=0; frames:Buffer[]=[]; blocked=false;
  write(b:Buffer){this.frames.push(b);return !this.blocked;}
  end(b:Buffer,cb?:()=>void){this.write(b);this.destroyed=true;cb?.();}
  destroy(){this.destroyed=true;this.emit('close');}
}
const types=(p:Peer)=>p.frames.flatMap(b=>new WireDecoder().push(b)).map(f=>f.type);
function setup(){return new ViewerHub(()=>wire(FrameType.snapshot,{outputOffset:4}),from=>from===2?[Buffer.from('ab')]:null,fn=>fn());}
test('16 viewers join, 17th refused and disconnect frees capacity',()=>{
 const hub=setup(),peers=Array.from({length:17},()=>new Peer());
 for(const p of peers){hub.add(p as any);p.emit('data',wire(FrameType.hello,{v:1}));}
 expect(hub.size).toBe(16);expect(types(peers[16])).toEqual([FrameType.exit]);
 peers[0].destroy();expect(hub.size).toBe(15);
});
test('snapshot, resume, output and control acknowledgement',()=>{
 const hub=setup(),p=new Peer();hub.add(p as any);
 p.emit('data',wire(FrameType.hello,{v:1,from:2,label:'watcher'}));
 expect(types(p)).toEqual([FrameType.output,FrameType.control]);
 hub.broadcast(wire(FrameType.output,Buffer.from('c')));expect(types(p)).toEqual([3,5,3]);
 p.emit('data',wire(FrameType.take,{}));expect(types(p).at(-1)).toBe(FrameType.control);expect(hub.controller).toBe('cli:watcher');
});
test('slow viewer overflows independently and gets resync with fresh snapshot',()=>{
 const hub=setup(),slow=new Peer(),fast=new Peer();hub.add(slow as any);hub.add(fast as any);
 for(const p of [slow,fast])p.emit('data',wire(FrameType.hello,{v:1}));
 slow.blocked=true;
 for(let i=0;i<18;i++)hub.broadcast(wire(FrameType.output,Buffer.alloc(65536)));
 expect(types(fast).filter(t=>t===3)).toHaveLength(18);
 slow.blocked=false;slow.emit('drain');
 expect(types(slow).slice(-3)).toEqual([FrameType.resync,FrameType.snapshot,FrameType.control]);
});
test('a single oversized output resyncs even when socket has never blocked',()=>{
 const hub=setup(),p=new Peer();hub.add(p as any);p.emit('data',wire(1,{v:1}));
 hub.broadcast(wire(3,Buffer.alloc(1024*1024)));
 expect(types(p).slice(-3)).toEqual([FrameType.resync,FrameType.snapshot,FrameType.control]);
 hub.broadcast(wire(3,Buffer.from('next')));expect(types(p).at(-1)).toBe(FrameType.output);
});
test('exit flushes queued output before its exit frame',async()=>{
 const hub=setup(),p=new Peer();hub.add(p as any);p.emit('data',wire(1,{v:1}));p.blocked=true;
 hub.broadcast(wire(3,Buffer.from('first')));hub.broadcast(wire(3,Buffer.from('last')));
 const ending=hub.end(0);p.blocked=false;p.emit('drain');await ending;expect(types(p).slice(-3)).toEqual([3,3,7]);
});
test('end dates the exit frame with the recorded end time and omits the field when the host did not record one',async()=>{
 const hub=setup(),p=new Peer();hub.add(p as any);p.emit('data',wire(1,{v:1}));
 await hub.end(143,1762876932.4);
 const exit=new WireDecoder().push(Buffer.concat(p.frames)).at(-1)!;
 expect(JSON.parse(exit.data.toString())).toEqual({code:143,at:1762876932});
 const unknown=setup(),q=new Peer();unknown.add(q as any);q.emit('data',wire(1,{v:1}));
 await unknown.end(143);
 const bare=new WireDecoder().push(Buffer.concat(q.frames)).at(-1)!;
 expect(JSON.parse(bare.data.toString())).toEqual({code:143});
});
test('rejected viewers have an error handler before refusal is written',()=>{
 const hub=setup();for(let i=0;i<16;i++){const p=new Peer();hub.add(p as any);p.emit('data',wire(FrameType.hello,{v:1}));}
 class Reset extends Peer{end(b:Buffer){this.emit('error',Error('reset'));super.end(b);}}
 expect(()=>{const p=new Reset();hub.add(p as any);p.emit('data',wire(FrameType.hello,{v:1}));}).not.toThrow();expect(hub.size).toBe(16);
});
test('large snapshots stream in bounded writes while preserving snapshot and control frames',()=>{
 const snapshot=wire(2,{screenAnsi:'x'.repeat(2*1024*1024)});
 const hub=new ViewerHub(()=>snapshot,()=>null,fn=>fn());const p=new Peer();hub.add(p as any);p.emit('data',wire(1,{v:1}));
 expect(Math.max(...p.frames.map(b=>b.length))).toBeLessThanOrEqual(65536);
 const decoded=new WireDecoder().push(Buffer.concat(p.frames));expect(decoded.map(f=>f.type)).toEqual([FrameType.snapshot,FrameType.control]);
});
test('CLI viewer displays the server refusal reason before detaching',async()=>{
 const {renderSessionFrame}=await import('../src/session/attach');const errors:string[]=[];
 expect(renderSessionFrame(FrameType.exit,Buffer.from(JSON.stringify({code:1,reason:'Session already has 16 viewers'})),{write(){},isTTY:false} as any,{write(s:string){errors.push(s);}} as any)).toBe(true);
 expect(errors.join('')).toContain('Session already has 16 viewers');
});
test('only an explicit controller release hands back a takeover; disconnect and steal do not',()=>{
 const released:string[]=[];
 const hub=new ViewerHub(()=>wire(FrameType.snapshot,{}),()=>null,fn=>fn(),()=>{},()=>{},{
  input:()=>{},resize:()=>{},release:label=>released.push(label),
 });
 const a=new Peer(),b=new Peer();hub.add(a as any);hub.add(b as any);
 a.emit('data',wire(FrameType.hello,{v:1,label:'one'}));b.emit('data',wire(FrameType.hello,{v:1,label:'two'}));
 a.emit('data',wire(FrameType.take,{}));b.emit('data',wire(FrameType.release,{}));
 expect(released).toEqual([]);
 b.emit('data',wire(FrameType.take,{force:true}));a.destroy();
 expect(released).toEqual([]);
 b.emit('data',wire(FrameType.release,{}));
 expect(released).toEqual(['cli:two']);
 b.emit('data',wire(FrameType.take,{}));b.destroy();
 expect(released).toEqual(['cli:two']);
});

// Session protocol 1.2 (ADR 0023): no controller, read-only viewers, size follows the active client.
const MODERN=[1,2] as [number,number];
function shared(timing?:Partial<DeliveryTiming>,refuseDeliver=false){
 const inputs:string[]=[],deliveries:string[]=[],sizes:[number,number][]=[],markers:string[]=[],released:string[]=[],states:{viewers:number;controller:string|null;active:string|null}[]=[];
 const hub=new ViewerHub(()=>wire(FrameType.snapshot,{controller:hub.controller,active:hub.active}),()=>null,fn=>fn(),(kind,label)=>markers.push(`${kind}:${label}`),
  (viewers,controller,active)=>states.push({viewers,controller,active}),
  {input:(b,delivery)=>{inputs.push(b.toString('latin1'));if(delivery)deliveries.push(b.toString('latin1'));},resize:(c,r)=>sizes.push([c,r]),release:l=>released.push(l)},{pacer:'0.0.0',versions:MODERN},timing,refuseDeliver);
 const join=(label:string,hello:Record<string,unknown>={versions:MODERN})=>{const p=new Peer();hub.add(p as any);p.emit('data',wire(FrameType.hello,{v:1,label,...hello}));return p;};
 return {hub,inputs,deliveries,sizes,markers,released,states,join};
}
const controlsOf=(p:Peer)=>p.frames.flatMap(b=>new WireDecoder().push(b)).filter(f=>f.type===FrameType.control).map(f=>JSON.parse(f.data.toString()));
const framesOf=(p:Peer)=>p.frames.flatMap(b=>new WireDecoder().push(b));
test('1.2: two interactive clients both type, in arrival order, attributed in the recording',()=>{
 const {hub,inputs,markers,join}=shared(),a=join('one'),b=join('two');
 expect(controlsOf(a)[0]).toMatchObject({controller:null,you:true,versions:MODERN});
 a.emit('data',wire(FrameType.input,Buffer.from('ab')));b.emit('data',wire(FrameType.input,Buffer.from('cd')));
 a.emit('data',wire(FrameType.input,Buffer.from('ef')));a.emit('data',wire(FrameType.input,Buffer.from('gh')));
 expect(inputs).toEqual(['ab','cd','ef','gh']);
 expect(markers).toEqual(['attach:cli:one','attach:cli:two','input:cli:one','input:cli:two','input:cli:one']);
 expect(hub.controller).toBeNull();expect(hub.active).toBe('cli:one');
});
test('1.2: a read-only viewer watches but its input, size, focus and take are dropped',()=>{
 const {hub,inputs,sizes,join}=shared(),watcher=join('watch',{versions:MODERN,readOnly:true});
 expect(controlsOf(watcher)[0]).toMatchObject({controller:null,you:false});
 watcher.emit('data',wire(FrameType.input,Buffer.from('typed')));
 watcher.emit('data',wire(FrameType.size,{cols:80,rows:24}));watcher.emit('data',wire(FrameType.focus,{}));
 watcher.emit('data',wire(FrameType.take,{force:true}));
 expect(inputs).toEqual([]);expect(sizes).toEqual([]);expect(hub.active).toBeNull();
 expect(controlsOf(watcher).at(-1)).toEqual({controller:null,you:false,active:null,reason:'read-only'});
 hub.broadcast(wire(FrameType.output,Buffer.from('still watching')));expect(framesOf(watcher).at(-1)?.type).toBe(FrameType.output);
});
test('1.2: the PTY size follows the most recently focused or typing client and keeps its last size',()=>{
 const {hub,sizes,states,join}=shared(),a=join('a'),b=join('b');
 a.emit('data',wire(FrameType.size,{cols:100,rows:30}));b.emit('data',wire(FrameType.size,{cols:80,rows:24}));
 expect(sizes).toEqual([]);
 a.emit('data',wire(FrameType.focus,{}));expect(sizes).toEqual([[100,30]]);expect(hub.active).toBe('cli:a');
 b.emit('data',wire(FrameType.size,{cols:81,rows:25}));expect(sizes).toEqual([[100,30]]);
 b.emit('data',wire(FrameType.input,Buffer.from('x')));expect(sizes).toEqual([[100,30],[81,25]]);
 b.emit('data',wire(FrameType.size,{cols:90,rows:20}));expect(sizes.at(-1)).toEqual([90,20]);
 b.emit('data',wire(FrameType.focus,{}));expect(sizes).toHaveLength(3);
 for(const body of [{cols:0,rows:1},{cols:1001,rows:1},{cols:1.5,rows:2}])b.emit('data',wire(FrameType.size,body));
 expect(sizes).toHaveLength(3);
 expect(states.at(-1)).toEqual({viewers:2,controller:null,active:'cli:b'});
 b.destroy();expect(hub.active).toBeNull();expect(states.at(-1)).toEqual({viewers:1,controller:null,active:null});
 a.emit('data',wire(FrameType.size,{cols:70,rows:20}));expect(sizes).toHaveLength(3);
});
test('1.2 host: a 1.1 client takes without a controller, types, and its release hands back a takeover',()=>{
 const {hub,inputs,released,join}=shared(),old=join('old',{}),other=join('other',{});
 expect(controlsOf(old)[0]).toEqual({controller:null,you:false});
 old.emit('data',wire(FrameType.input,Buffer.from('before take')));expect(inputs).toEqual([]);
 old.emit('data',wire(FrameType.take,{}));
 expect(controlsOf(old).at(-1)).toEqual({controller:null,you:true});
 other.emit('data',wire(FrameType.take,{force:true}));
 expect(controlsOf(other).at(-1)).toEqual({controller:null,you:true});
 expect(controlsOf(old)).toHaveLength(2);
 old.emit('data',wire(FrameType.input,Buffer.from('one')));other.emit('data',wire(FrameType.input,Buffer.from('two')));
 expect(inputs).toEqual(['one','two']);
 for(const p of [old,other])for(const f of framesOf(p))if(f.type===FrameType.control||f.type===FrameType.snapshot)expect(JSON.parse(f.data.toString()).controller).toBeNull();
 const late=join('late',{});expect(JSON.parse(framesOf(late)[0].data.toString())).toMatchObject({controller:null,active:'cli:other'});
 late.emit('data',wire(FrameType.release,{}));expect(released).toEqual([]);
 old.emit('data',wire(FrameType.release,{}));
 expect(controlsOf(old).at(-1)).toEqual({controller:null,you:false,reason:'released'});
 expect(released).toEqual(['cli:old']);
 old.emit('data',wire(FrameType.input,Buffer.from('after release')));expect(inputs).toEqual(['one','two']);
 const modern=join('modern');modern.emit('data',wire(FrameType.take,{}));modern.emit('data',wire(FrameType.release,{}));
 expect(released).toEqual(['cli:old']);expect(hub.controller).toBeNull();
});
test('1.2 host strips client replies to terminal queries; cursor reports only right after the host answered one',()=>{
 const {hub,inputs,join}=shared(),a=join('a'),b=join('b');
 a.emit('data',wire(FrameType.input,Buffer.from('\x1b[?62;22c\x1b[>0;276;0c')));
 b.emit('data',wire(FrameType.input,Buffer.from('x\x1b]11;rgb:0000/0000/0000\x1b\\y\x1b]10;rgb:ffff/ffff/ffff\x07')));
 expect(inputs).toEqual(['xy']);expect(hub.active).toBe('cli:b');
 a.emit('data',wire(FrameType.input,Buffer.from('\x1b[1;2R')));expect(inputs.at(-1)).toBe('\x1b[1;2R');
 hub.answeredCursorReport();
 a.emit('data',wire(FrameType.input,Buffer.from('\x1b[12;40R')));b.emit('data',wire(FrameType.input,Buffer.from('\x1b[12;40Rz')));
 expect(inputs).toEqual(['xy','\x1b[1;2R','z']);
});
test('a 1.1 host keeps take and release for a client that negotiated 1.1',()=>{
 const inputs:string[]=[],hub=new ViewerHub(()=>wire(FrameType.snapshot,{}),()=>null,fn=>fn(),()=>{},()=>{},{input:b=>inputs.push(b.toString()),resize:()=>{}},{pacer:'0.0.0',versions:[1,1]});
 const a=new Peer(),b=new Peer();hub.add(a as any);hub.add(b as any);
 a.emit('data',wire(FrameType.hello,{v:1,label:'a',versions:MODERN}));b.emit('data',wire(FrameType.hello,{v:1,label:'b',versions:MODERN}));
 a.emit('data',wire(FrameType.input,Buffer.from('dropped')));a.emit('data',wire(FrameType.focus,{}));
 a.emit('data',wire(FrameType.take,{}));b.emit('data',wire(FrameType.take,{}));
 a.emit('data',wire(FrameType.input,Buffer.from('kept')));b.emit('data',wire(FrameType.input,Buffer.from('dropped')));
 expect(inputs).toEqual(['kept']);expect(hub.controller).toBe('cli:a');
 expect(controlsOf(b).at(-1)).toMatchObject({controller:'cli:a',you:false,reason:'refused'});
});

// Delivery window (ADR 0023, decision 4): pacer's automated input waits for quiet and no pending human line.
const FAST={quietMs:40,windowMs:120,timeoutMs:250};
const deliveredOf=(p:Peer)=>framesOf(p).filter(f=>f.type===FrameType.delivered).map(f=>JSON.parse(f.data.toString()));
const grantedOf=(p:Peer)=>framesOf(p).filter(f=>f.type===FrameType.granted);
test('delivery timing defaults are the ADR values',()=>{
 expect(DELIVERY_TIMING).toEqual({quietMs:1500,windowMs:2000,timeoutMs:10000,maxWindowMs:10000});
});
test('1.2 deliver: granted after quiet; other input is held, never dropped, and applied after the delivery',async()=>{
 const {inputs,join}=shared(FAST),pacer=join('pacer'),human=join('human');
 human.emit('data',wire(FrameType.input,Buffer.from('done\r')));
 pacer.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(pacer)).toHaveLength(0);
 await Bun.sleep(80);
 expect(grantedOf(pacer)).toHaveLength(1);
 human.emit('data',wire(FrameType.input,Buffer.from('held')));
 pacer.emit('data',wire(FrameType.input,Buffer.from('paste')));pacer.emit('data',wire(FrameType.input,Buffer.from('\r')));
 expect(inputs).toEqual(['done\r','paste','\r']);
 pacer.emit('data',wire(FrameType.deliver,{done:true}));
 expect(inputs).toEqual(['done\r','paste','\r','held']);
 expect(deliveredOf(pacer)).toEqual([{ok:true,label:'cli:pacer'}]);
 expect(deliveredOf(human)).toEqual([{ok:true,label:'cli:pacer'}]);
});
test('1.2 deliver: a fresh session with no input is granted at once',()=>{
 const {join}=shared(FAST),pacer=join('pacer');
 pacer.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(pacer)).toHaveLength(1);
});
test('1.2 deliver: a pending human line refuses after the timeout and names the client',async()=>{
 const {inputs,join}=shared(FAST),pacer=join('pacer'),app=join('Pacer desktop',{versions:MODERN,client:'app'});
 app.emit('data',wire(FrameType.input,Buffer.from('half a line\x1b[D')));
 pacer.emit('data',wire(FrameType.deliver,{}));
 await Bun.sleep(150);
 expect(grantedOf(pacer)).toHaveLength(0);expect(deliveredOf(pacer)).toEqual([]);
 await Bun.sleep(200);
 expect(grantedOf(pacer)).toHaveLength(0);
 expect(deliveredOf(pacer)).toEqual([{ok:false,cause:'pending',from:'app:Pacer desktop',reason:'unsent input in the agent from Pacer desktop'}]);
 expect(deliveredOf(app)).toEqual([]);
 expect(inputs).toEqual(['half a line\x1b[D']);
});
test('1.2 deliver: Enter ends the pending line, then the quiet period grants',async()=>{
 const {join}=shared(FAST),pacer=join('pacer'),human=join('human');
 human.emit('data',wire(FrameType.input,Buffer.from('typing')));
 pacer.emit('data',wire(FrameType.deliver,{}));
 await Bun.sleep(80);expect(grantedOf(pacer)).toHaveLength(0);
 human.emit('data',wire(FrameType.input,Buffer.from('\r')));
 await Bun.sleep(20);expect(grantedOf(pacer)).toHaveLength(0);
 await Bun.sleep(60);expect(grantedOf(pacer)).toHaveLength(1);
});
test('1.2 deliver: steady input times out naming the most recent typist',async()=>{
 const {join}=shared(FAST),pacer=join('pacer'),human=join('human');
 pacer.emit('data',wire(FrameType.input,Buffer.from('\r')));
 human.emit('data',wire(FrameType.input,Buffer.from('\r')));
 pacer.emit('data',wire(FrameType.deliver,{}));
 for(let i=0;i<14;i++){await Bun.sleep(20);human.emit('data',wire(FrameType.input,Buffer.from('\x1b[A')));}
 await Bun.sleep(30);
 expect(deliveredOf(pacer)).toEqual([{ok:false,cause:'input',from:'cli:human',reason:'recent input from human'}]);
});
const EXPIRED_UNUSED={ok:false,cause:'expired-unused',reason:'the delivery window expired before any input was typed'};
test('1.2 deliver: the window expires after windowMs and releases held input',async()=>{
 const {inputs,join}=shared(FAST),pacer=join('pacer'),human=join('human');
 pacer.emit('data',wire(FrameType.deliver,{}));
 human.emit('data',wire(FrameType.input,Buffer.from('waiting')));
 expect(inputs).toEqual([]);
 await Bun.sleep(160);
 expect(inputs).toEqual(['waiting']);
 expect(deliveredOf(pacer)).toEqual([EXPIRED_UNUSED]);
 pacer.emit('data',wire(FrameType.deliver,{done:true}));
 expect(deliveredOf(pacer)).toHaveLength(1);
});
test('1.2 deliver: after a window expires unused, the requester\'s late paste is dropped and never joins the held half-line',async()=>{
 const {hub,inputs,deliveries,states,join}=shared(FAST),human=join('human'),pacer=join('pacer');
 human.emit('data',wire(FrameType.focus,{}));
 pacer.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(pacer)).toHaveLength(1);
 human.emit('data',wire(FrameType.input,Buffer.from('half typed')));
 await Bun.sleep(FAST.windowMs+40);
 pacer.emit('data',wire(FrameType.input,Buffer.from('PASTE')));
 pacer.emit('data',wire(FrameType.input,Buffer.from('\r')));
 pacer.emit('data',wire(FrameType.deliver,{done:true}));
 expect(inputs).toEqual(['half typed']);
 expect(deliveries).toEqual([]);
 expect(deliveredOf(pacer)).toEqual([EXPIRED_UNUSED]);
 expect(deliveredOf(human)).toEqual([]);
 expect(hub.active).toBe('cli:human');
 expect(states.map(s=>s.active)).not.toContain('cli:pacer');
});
test('1.2 deliver: input dropped after an unused expiry flows again after a cancel or a new deliver',async()=>{
 const {inputs,deliveries,join}=shared(FAST),pacer=join('pacer');
 pacer.emit('data',wire(FrameType.deliver,{}));
 await Bun.sleep(FAST.windowMs+40);
 pacer.emit('data',wire(FrameType.input,Buffer.from('late')));
 pacer.emit('data',wire(FrameType.deliver,{cancel:true}));
 pacer.emit('data',wire(FrameType.input,Buffer.from('after cancel')));
 expect(inputs).toEqual(['after cancel']);
 const fresh=shared(FAST),again=fresh.join('pacer');
 again.emit('data',wire(FrameType.deliver,{}));
 await Bun.sleep(FAST.windowMs+40);
 again.emit('data',wire(FrameType.input,Buffer.from('late')));
 again.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(again)).toHaveLength(2);
 again.emit('data',wire(FrameType.input,Buffer.from('paste\r')));again.emit('data',wire(FrameType.deliver,{done:true}));
 expect(fresh.inputs).toEqual(['paste\r']);
 expect(fresh.deliveries).toEqual(['paste\r']);
 expect(deliveredOf(again)).toEqual([EXPIRED_UNUSED,{ok:true,label:'cli:pacer'}]);
 expect(deliveries).toEqual([]);
});
test('1.2 deliver: cancel ends the window, flushes held input and reports it',()=>{
 const {inputs,join}=shared(FAST),pacer=join('pacer'),human=join('human');
 pacer.emit('data',wire(FrameType.deliver,{}));
 human.emit('data',wire(FrameType.input,Buffer.from('mine')));
 pacer.emit('data',wire(FrameType.deliver,{cancel:true}));
 expect(inputs).toEqual(['mine']);
 expect(deliveredOf(pacer)).toEqual([{ok:false,cause:'cancelled',reason:'the delivery was cancelled'}]);
 expect(deliveredOf(human)).toEqual([]);
});
test('1.2 deliver: a requester that disconnects ends its window',()=>{
 const {inputs,join}=shared(FAST),pacer=join('pacer'),human=join('human');
 pacer.emit('data',wire(FrameType.deliver,{}));
 human.emit('data',wire(FrameType.input,Buffer.from('mine')));
 pacer.destroy();
 expect(inputs).toEqual(['mine']);
 human.emit('data',wire(FrameType.input,Buffer.from('more')));
 expect(inputs).toEqual(['mine','more']);
});
test('1.2 deliver: one window at a time; a second request waits its turn',()=>{
 const {join}=shared(FAST),one=join('one'),two=join('two');
 one.emit('data',wire(FrameType.deliver,{}));two.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(one)).toHaveLength(1);expect(grantedOf(two)).toHaveLength(0);
 one.emit('data',wire(FrameType.deliver,{}));
 expect(deliveredOf(one)).toEqual([{ok:false,cause:'duplicate',reason:'a delivery is already pending'}]);
 one.emit('data',wire(FrameType.deliver,{done:true}));
 expect(grantedOf(two)).toHaveLength(1);
});
test('deliver is refused from read-only viewers and ignored from 1.1 clients and on 1.1 hosts',()=>{
 const {inputs,join}=shared(FAST),watcher=join('watch',{versions:MODERN,readOnly:true}),old=join('old',{});
 watcher.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(watcher)).toHaveLength(0);
 expect(deliveredOf(watcher)).toEqual([{ok:false,cause:'read-only',reason:'read-only viewers cannot deliver input'}]);
 old.emit('data',wire(FrameType.take,{}));old.emit('data',wire(FrameType.deliver,{}));
 expect(framesOf(old).filter(f=>f.type===FrameType.granted||f.type===FrameType.delivered)).toEqual([]);
 old.emit('data',wire(FrameType.input,Buffer.from('typed')));expect(inputs).toEqual(['typed']);
 const hub=new ViewerHub(()=>wire(FrameType.snapshot,{}),()=>null,fn=>fn(),()=>{},()=>{},{input:()=>{},resize:()=>{}},{pacer:'0.0.0',versions:[1,1]},FAST);
 const p=new Peer();hub.add(p as any);p.emit('data',wire(FrameType.hello,{v:1,label:'p',versions:MODERN}));
 p.emit('data',wire(FrameType.deliver,{}));
 expect(framesOf(p).filter(f=>f.type===FrameType.granted||f.type===FrameType.delivered)).toEqual([]);
});
test('1.2 deliver: once the requester starts typing, the window outlasts windowMs so Enter is never split from its paste',async()=>{
 const {inputs,join}=shared(FAST),pacer=join('pacer'),human=join('human');
 pacer.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(pacer)).toHaveLength(1);
 pacer.emit('data',wire(FrameType.input,Buffer.from('PASTE')));
 human.emit('data',wire(FrameType.input,Buffer.from('half typed')));
 await Bun.sleep(FAST.windowMs+60);
 expect(inputs).toEqual(['PASTE']);
 expect(deliveredOf(pacer)).toEqual([]);
 pacer.emit('data',wire(FrameType.input,Buffer.from('\r')));
 pacer.emit('data',wire(FrameType.deliver,{done:true}));
 expect(inputs).toEqual(['PASTE','\r','half typed']);
 expect(deliveredOf(pacer)).toEqual([{ok:true,label:'cli:pacer'}]);
});
test('1.2 deliver: a requester that started typing but never finishes is cut off at maxWindowMs',async()=>{
 const {inputs,join}=shared({...FAST,maxWindowMs:220}),pacer=join('pacer'),human=join('human');
 pacer.emit('data',wire(FrameType.deliver,{}));
 pacer.emit('data',wire(FrameType.input,Buffer.from('PASTE')));
 human.emit('data',wire(FrameType.input,Buffer.from('held')));
 await Bun.sleep(160);
 expect(inputs).toEqual(['PASTE']);
 await Bun.sleep(120);
 expect(inputs).toEqual(['PASTE','held']);
 expect(deliveredOf(pacer)).toEqual([{ok:false,cause:'expired',reason:'the delivery window expired'}]);
});
test('1.2 deliver: the requester\'s own input is marked as a delivery and starts no quiet period',()=>{
 const {inputs,deliveries,join}=shared(FAST),pacer=join('pacer'),human=join('human');
 pacer.emit('data',wire(FrameType.deliver,{}));
 human.emit('data',wire(FrameType.input,Buffer.from('held')));
 pacer.emit('data',wire(FrameType.input,Buffer.from('paste')));pacer.emit('data',wire(FrameType.input,Buffer.from('\r')));
 pacer.emit('data',wire(FrameType.deliver,{done:true}));
 expect(inputs).toEqual(['paste','\r','held']);
 expect(deliveries).toEqual(['paste','\r']);
 const other=join('other');
 human.emit('data',wire(FrameType.input,Buffer.from('\r')));
 other.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(other)).toHaveLength(0);
 const fresh=shared(FAST),first=fresh.join('first'),second=fresh.join('second');
 first.emit('data',wire(FrameType.deliver,{}));
 first.emit('data',wire(FrameType.input,Buffer.from('paste\r')));first.emit('data',wire(FrameType.deliver,{done:true}));
 second.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(second)).toHaveLength(1);
});
test('1.2 deliver: the requester does not become the active client, so the size keeps following the human',()=>{
 const {hub,sizes,states,join}=shared(FAST),human=join('human'),pacer=join('pacer');
 human.emit('data',wire(FrameType.size,{cols:100,rows:30}));human.emit('data',wire(FrameType.focus,{}));
 expect(hub.active).toBe('cli:human');
 pacer.emit('data',wire(FrameType.deliver,{}));
 pacer.emit('data',wire(FrameType.input,Buffer.from('paste\r')));pacer.emit('data',wire(FrameType.deliver,{done:true}));
 expect(hub.active).toBe('cli:human');
 expect(states.map(s=>s.active)).not.toContain('cli:pacer');
 pacer.destroy();expect(hub.active).toBe('cli:human');
 human.emit('data',wire(FrameType.size,{cols:90,rows:20}));
 expect(sizes).toEqual([[100,30],[90,20]]);
});
test('1.2 pending line: Backspace and DEL remove typed characters; reaching none clears it',async()=>{
 for(const erase of ['\x7f','\x08']){
  const {join}=shared(FAST),pacer=join('pacer'),human=join('human');
  human.emit('data',wire(FrameType.input,Buffer.from('ab')));human.emit('data',wire(FrameType.input,Buffer.from(erase)));
  pacer.emit('data',wire(FrameType.deliver,{}));
  await Bun.sleep(80);expect(grantedOf(pacer)).toHaveLength(0);
  human.emit('data',wire(FrameType.input,Buffer.from(erase)));
  await Bun.sleep(80);expect(grantedOf(pacer)).toHaveLength(1);
 }
});
test('1.2 pending line: extra Backspaces do not go below empty, and multibyte characters count once',async()=>{
 const {join}=shared(FAST),pacer=join('pacer'),human=join('human');
 human.emit('data',wire(FrameType.input,Buffer.from('\x7f\x7f\x7f')));
 human.emit('data',wire(FrameType.input,Buffer.from('é')));human.emit('data',wire(FrameType.input,Buffer.from('\x7f')));
 pacer.emit('data',wire(FrameType.deliver,{}));
 await Bun.sleep(80);expect(grantedOf(pacer)).toHaveLength(1);
});
test('1.2 pending line: a lone Esc clears it; Esc starting a sequence does not',async()=>{
 const {join}=shared(FAST),pacer=join('pacer'),human=join('human');
 human.emit('data',wire(FrameType.input,Buffer.from('draft\x1b[D')));
 pacer.emit('data',wire(FrameType.deliver,{}));
 await Bun.sleep(80);expect(grantedOf(pacer)).toHaveLength(0);
 human.emit('data',wire(FrameType.input,Buffer.from('\x1b')));
 await Bun.sleep(80);expect(grantedOf(pacer)).toHaveLength(1);
});
test('1.2 pending line: Ctrl-C, Ctrl-U, CR and LF each end it',async()=>{
 for(const end of ['\x03','\x15','\r','\n']){
  const {join}=shared(FAST),pacer=join('pacer'),human=join('human');
  human.emit('data',wire(FrameType.input,Buffer.from('draft')));
  pacer.emit('data',wire(FrameType.deliver,{}));
  await Bun.sleep(80);expect(grantedOf(pacer)).toHaveLength(0);
  human.emit('data',wire(FrameType.input,Buffer.from(`more${end}`)));
  await Bun.sleep(80);expect(grantedOf(pacer)).toHaveLength(1);
 }
});
test('a host that refuses deliveries (the built-in terminal) answers every deliver with refused',()=>{
 const {inputs,join}=shared(FAST,true),pacer=join('pacer'),human=join('human');
 pacer.emit('data',wire(FrameType.deliver,{}));
 expect(grantedOf(pacer)).toHaveLength(0);
 expect(deliveredOf(pacer)).toEqual([{ok:false,cause:'refused',reason:'this terminal does not accept automated input'}]);
 human.emit('data',wire(FrameType.input,Buffer.from('ls\r')));pacer.emit('data',wire(FrameType.input,Buffer.from('typed')));
 expect(inputs).toEqual(['ls\r','typed']);
});
