import { createConnection, type Socket } from 'node:net';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { Ctx } from '../types';
import { FrameType, WireDecoder, wire, MAX_FRAME, type Frame } from '../session/framing';
import { sessionDirectory, sessionSocket } from '../session/service';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
export interface SessionWS { socket:Socket; decoder:WireDecoder; from?:number }
const names=new Map<number,string>(Object.entries(FrameType).map(([k,v])=>[v,k]));
/** JSON messages carry the named frame type plus the original body fields. */
export function socketFrameMessage(frame:Frame):string|Buffer{
 if(frame.type===FrameType.output||frame.type===FrameType.input)return wire(frame.type,frame.data);
 return JSON.stringify({type:names.get(frame.type),...JSON.parse(frame.data.toString())});
}
export function viewerMessageFrames(message:string|Buffer,from?:number):Buffer[]{
 let frames:Frame[];
 if(typeof message==='string'){
  const {type,...body}=JSON.parse(message);
  if(typeof type!=='string'||!Object.hasOwn(FrameType,type))throw Error('unknown session frame');
  frames=[{type:FrameType[type as keyof typeof FrameType],data:Buffer.from(JSON.stringify(body))}];
 }else{
  const decoder=new WireDecoder();frames=decoder.push(message);
  // Each binary WebSocket message must contain complete wire frames.
  if(frames.reduce((n,f)=>n+5+f.data.length,0)!==message.length)throw Error('incomplete session frame');
 }
 return frames.map(f=>f.type===FrameType.hello
  ?wire(f.type,{...JSON.parse(f.data.toString()),client:'app',...(from===undefined?{}:{from})})
  :wire(f.type,f.data));
}
export const sessionWebSocket:WebSocketHandler<SessionWS>={
 maxPayloadLength:1024*1024,backpressureLimit:MAX_FRAME+5,closeOnBackpressureLimit:true,
 open(ws){
  const {socket,decoder}=ws.data;
  socket.on('data',bytes=>{try{for(const frame of decoder.push(Buffer.from(bytes))){
   const message=socketFrameMessage(frame),sent=typeof message==='string'?ws.sendText(message):ws.sendBinary(message);
   if(sent===-1)socket.pause();
   if(sent===0){socket.destroy();return;}
  }}catch{ws.close(1002,'Invalid session frame');socket.destroy();}});
  socket.on('close',()=>ws.close());socket.on('error',()=>ws.close(1011,'Session socket closed'));socket.resume();
 },
 message(ws,message){try{
  for(const bytes of viewerMessageFrames(message,ws.data.from)){
   if(ws.data.socket.writableLength+bytes.length>1024*1024){ws.close(1009,'Session input queue exceeded');ws.data.socket.destroy();return;}
   ws.data.socket.write(bytes);
  }
 }catch{ws.close(1002,'Invalid session frame');ws.data.socket.destroy();}},
 drain(ws){ws.data.socket.resume();},
 close(ws){ws.data.socket.destroy();},
};
export async function upgradeSession(req:Request,server:Server<SessionWS>,ctx:Ctx,id:string):Promise<Response|undefined>{
 if(req.method!=='GET')return new Response('method not allowed',{status:405});
 try{
  const dir=sessionDirectory(ctx,id);
  if(!dir||existsSync(join(dir,'exit'))||!existsSync(sessionSocket(dir)))return new Response('Live session unavailable',{status:409});
  const raw=new URL(req.url).searchParams.get('from'),from=raw===null?undefined:Number(raw);
  if(from!==undefined&&(!Number.isSafeInteger(from)||from<0||raw===''))return new Response('invalid from offset',{status:400});
  const socket=createConnection(sessionSocket(dir));socket.pause();socket.on('error',()=>{});
  try{await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{socket.destroy();reject(Error('session connection timeout'));},2000);
   socket.once('connect',()=>{clearTimeout(timer);resolve();});socket.once('error',e=>{clearTimeout(timer);reject(e);});
  });}catch{socket.destroy();return new Response('Live session unavailable',{status:409});}
  if(server.upgrade(req,{data:{socket,decoder:new WireDecoder(),from}}))return;
  socket.destroy();return new Response('WebSocket upgrade required',{status:426});
 }catch{return new Response('Session not found',{status:404});}
}
