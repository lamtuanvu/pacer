import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ViewerHub } from '../src/session/viewers';
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
function shared(){
 const inputs:string[]=[],sizes:[number,number][]=[],markers:string[]=[],released:string[]=[],states:{viewers:number;controller:string|null;active:string|null}[]=[];
 const hub=new ViewerHub(()=>wire(FrameType.snapshot,{controller:hub.controller,active:hub.active}),()=>null,fn=>fn(),(kind,label)=>markers.push(`${kind}:${label}`),
  (viewers,controller,active)=>states.push({viewers,controller,active}),
  {input:b=>inputs.push(b.toString('latin1')),resize:(c,r)=>sizes.push([c,r]),release:l=>released.push(l)},{pacer:'0.0.0',versions:MODERN});
 const join=(label:string,hello:Record<string,unknown>={versions:MODERN})=>{const p=new Peer();hub.add(p as any);p.emit('data',wire(FrameType.hello,{v:1,label,...hello}));return p;};
 return {hub,inputs,sizes,markers,released,states,join};
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
 expect(controlsOf(watcher).at(-1)).toEqual({controller:null,you:false,reason:'read-only'});
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
