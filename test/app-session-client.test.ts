import { expect, test } from 'bun:test';
import { SessionClient, type SessionSocket } from '../app/src/term/client';
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
 expect(socket.json().filter(frame=>frame.type==='take')).toEqual([{type:'take'}]);
 socket.frame({type:'control',controller:'app',you:true});free.client.release();
 socket.frame({type:'control',controller:null,you:false});
 expect(socket.json().filter(frame=>frame.type==='take')).toHaveLength(1);
 free.client.dispose();
 const held=fixture(true),other=held.sockets[0]!;
 other.frame({type:'snapshot',outputOffset:0,cols:120,rows:40,scrollbackAnsi:'',screenAnsi:'',controller:'cli',viewers:2});
 expect(other.json().filter(frame=>frame.type==='take')).toEqual([]);
 held.client.dispose();
});
test('snapshot precedes output, byte offsets resume after a drop and resync replaces screen',()=>{const f=fixture(false),s=f.sockets[0]!;
 expect(s.json()[0]).toEqual({type:'hello',v:1,client:'app',label:'app',cols:120,rows:40});
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
