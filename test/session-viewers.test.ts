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
