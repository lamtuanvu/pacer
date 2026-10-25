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
