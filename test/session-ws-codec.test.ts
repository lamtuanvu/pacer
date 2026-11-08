import { expect, test } from 'bun:test';
import { socketFrameMessage, viewerMessageFrames } from '../src/serve/session-ws';
import { FrameType, WireDecoder, wire } from '../src/session/framing';
test('bridge tags all hello clients and keeps resume offset',()=>{
 for(const message of [JSON.stringify({type:'hello',v:1,client:'cli',from:9}),wire(FrameType.hello,{v:1,client:'cli',from:9})]){
  const f=new WireDecoder().push(viewerMessageFrames(message)[0])[0];
  expect(JSON.parse(f.data.toString())).toEqual({v:1,client:'app',from:9});
 }
});
test('bridge relays arbitrary binary output and JSON bodies unchanged',()=>{
 const data=Buffer.from([0,255,27,128]);expect(socketFrameMessage({type:3,data})).toEqual(wire(3,data));
 const body={cols:80,rows:40};expect(JSON.parse(socketFrameMessage({type:4,data:Buffer.from(JSON.stringify(body))}) as string)).toEqual({type:'resize',...body});
 expect(viewerMessageFrames(wire(10,data))[0]).toEqual(wire(10,data));
 expect(()=>viewerMessageFrames(wire(1,{}).subarray(0,6))).toThrow();
});
test('bridge passes focus and a read-only hello through',()=>{
 const [focus]=new WireDecoder().push(viewerMessageFrames(JSON.stringify({type:'focus'}))[0]);
 expect(focus).toMatchObject({type:FrameType.focus});expect(JSON.parse(focus.data.toString())).toEqual({});
 expect(viewerMessageFrames(wire(FrameType.focus,{}))).toEqual([wire(FrameType.focus,{})]);
 const [hello]=new WireDecoder().push(viewerMessageFrames(JSON.stringify({type:'hello',v:1,versions:[1,2],readOnly:true}))[0]);
 expect(JSON.parse(hello.data.toString())).toEqual({v:1,versions:[1,2],readOnly:true,client:'app'});
});
test('bridge refuses deliver from WebSocket clients, as JSON or inside a binary message',()=>{
 expect(FrameType.deliver).toBeGreaterThan(FrameType.focus);
 expect(()=>viewerMessageFrames(JSON.stringify({type:'deliver',text:'hi'}))).toThrow();
 expect(()=>viewerMessageFrames(wire(FrameType.deliver,{text:'hi'}))).toThrow();
 expect(()=>viewerMessageFrames(Buffer.concat([wire(FrameType.input,Buffer.from('a')),wire(FrameType.deliver,{})]))).toThrow();
});
