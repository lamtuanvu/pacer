import {expect,test} from 'bun:test';
import {takeoverSession} from '../app/src/screens/session/takeover';
import fixture from './fixtures/ui/session.json';
import {SessionClient,type SessionSocket} from '../app/src/term/client';

test('starting takeover polls at 500 ms until ready, then requests control',async()=>{
 const events:string[]=[];let polls=0;
 const socket:SessionSocket={readyState:1,binaryType:'arraybuffer',onopen:null,onclose:null,onerror:null,onmessage:null,send:data=>{if(typeof data==='string'&&JSON.parse(data).type==='take')events.push('take');},close:()=>{}};
 const client=new SessionClient({url:'ws://test',label:'app',cols:120,rows:36,control:true,autoControl:false,socket:()=>socket});
 client.connect();socket.onopen?.();socket.onmessage?.({data:JSON.stringify({type:'snapshot',outputOffset:0,cols:120,rows:36,scrollbackAnsi:'',screenAnsi:'',controller:null,viewers:1})});
 await takeoverSession({id:'t1',call:async<T>(op:string,params:unknown)=>{
  expect(params).toEqual({id:'t1'});events.push(op);
  return (op==='task.takeover'?{state:'starting'}:{...fixture.session,live:++polls===2,driving:polls===2}) as T;
 },starting:()=>events.push('starting'),ready:()=>{void client.take();},sleep:async ms=>{expect(ms).toBe(500);events.push('sleep');}});
 expect(events).toEqual(['task.takeover','starting','sleep','task.session','sleep','task.session','take']);client.dispose();
});
test('driving takes immediately, ended refreshes without taking, and timeout can retry polling',async()=>{
 let takes=0;
 const options={id:'t1',call:async<T>()=>({...fixture.session,live:false,driving:false}) as T,starting:()=>{},ready:()=>{takes++;},sleep:async()=>{}};
 expect(await takeoverSession({...options,state:'driving'})).toBeDefined();expect(takes).toBe(1);
 expect(await takeoverSession({...options,state:'ended'})).toBeUndefined();expect(takes).toBe(1);
 await expect(takeoverSession({...options,state:'starting'})).rejects.toThrow('30 seconds');
 const result=await takeoverSession({...options,state:'starting',call:async<T>()=>({...fixture.session,live:true}) as T});
 expect(result?.live).toBe(true);expect(takes).toBe(2);
});
test('leaving during startup prevents a later take',async()=>{
 const abort=new AbortController();let takes=0,polls=0;
 await expect(takeoverSession({id:'t1',state:'starting',signal:abort.signal,starting:()=>{},ready:()=>{takes++;},sleep:async()=>{abort.abort();},call:async<T>()=>{polls++;return fixture.session as T;}})).rejects.toThrow('cancelled');
 expect(takes).toBe(0);expect(polls).toBe(0);
});
test('hand back on a 1.2 host calls task.hand_back for the task',async()=>{
 const {handBackSession}=await import('../app/src/screens/session/takeover');
 const calls:[string,unknown][]=[];
 await handBackSession({id:'t1',call:async<T>(op:string,params:unknown)=>{calls.push([op,params]);return {} as T;}});
 expect(calls).toEqual([['task.hand_back',{id:'t1'}]]);
 await expect(handBackSession({id:'t1',call:async()=>{throw new Error('not a takeover');}})).rejects.toThrow('not a takeover');
});
test('a takeover that becomes ready on a 1.2 host types without sending take',async()=>{
 const sent:string[]=[];
 const socket:SessionSocket={readyState:1,binaryType:'arraybuffer',onopen:null,onclose:null,onerror:null,onmessage:null,send:data=>{if(typeof data==='string')sent.push(JSON.parse(data).type);},close:()=>{}};
 const client=new SessionClient({url:'ws://test',label:'app',cols:120,rows:36,control:true,autoControl:true,socket:()=>socket});
 client.connect();socket.onopen?.();
 socket.onmessage?.({data:JSON.stringify({type:'snapshot',outputOffset:0,cols:120,rows:36,scrollbackAnsi:'',screenAnsi:'',controller:null,viewers:1})});
 socket.onmessage?.({data:JSON.stringify({type:'control',controller:null,you:true,versions:[1,2],pacer:'0.14.0'})});
 await takeoverSession({id:'t1',state:'driving',call:async<T>()=>({...fixture.session,live:true,driving:true}) as T,starting:()=>{},ready:()=>{void client.take();},sleep:async()=>{}});
 expect(sent).toEqual(['hello']);expect(client.input('x')).toBe(true);client.dispose();
});
test('the service-reported session minor decides whether a session is interactive, before any pane connects',async()=>{
 const {interactiveHost}=await import('../app/src/term/activity');
 const builtin={...fixture.session,host:'builtin' as const,live:true};
 expect(interactiveHost({...builtin,sessionMinor:2})).toBe(true);
 // The service's answer wins over a cached pane runtime in either direction.
 expect(interactiveHost({...builtin,sessionMinor:2},false)).toBe(true);
 expect(interactiveHost({...builtin,sessionMinor:1},true)).toBe(false);
 // An older core omits the field; a connected runtime is the only evidence then.
 expect(interactiveHost(builtin)).toBe(false);
 expect(interactiveHost(builtin,true)).toBe(true);
 expect(interactiveHost({...builtin,host:'orca',sessionMinor:2})).toBe(false);
 expect(interactiveHost(null,true)).toBe(true);
});
test('the task page offers Take over for a headless run or a live 1.1 session, never for a live 1.2 session',async()=>{
 const {offersTakeover}=await import('../app/src/screens/session/takeover');
 const builtin={...fixture.session,host:'builtin' as const,live:true,takeover:{available:false,reason:'This task is already interactive or being taken over.'}};
 expect(offersTakeover({...builtin,sessionMinor:1})).toBe(true);
 expect(offersTakeover({...builtin,sessionMinor:2})).toBe(false);
 // No cached runtime is needed: a cold task page reads the service's minor.
 expect(offersTakeover({...builtin,sessionMinor:2},false)).toBe(false);
 expect(offersTakeover({...builtin,live:false,sessionMinor:1})).toBe(false);
 expect(offersTakeover({...builtin,host:'none',live:false,takeover:{available:true}})).toBe(true);
 expect(offersTakeover(undefined)).toBe(false);
});
