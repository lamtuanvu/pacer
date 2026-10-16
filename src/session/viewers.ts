import type { Socket } from 'node:net';
import { FrameType, WireDecoder, wire } from './framing';
const CAP=1024*1024, SLICE=64*1024;
interface Viewer {
 socket:Socket; joined:boolean; blocked:boolean; pending:Buffer[]; bytes:number; resync:boolean; label:string;
 snapshot?:{bytes:Buffer;offset:number}; exitCode?:number; done?:()=>void;
}
/** Bounded output queues. Snapshot state is shared, and streamed in small writes. */
export class ViewerHub {
 private viewers=new Set<Viewer>();
 private cachedSnapshot?:Buffer;
 private closing=false;
 get size(){return this.viewers.size;}
 constructor(private snapshot:()=>Buffer,private since:(from:number)=>Buffer[]|null,
  private enqueue:(fn:()=>void)=>void,private marker:(kind:string,label:string)=>void=()=>{},private changed:(viewers:number)=>void=()=>{}){}
 private freshSnapshot(){return this.cachedSnapshot??=this.snapshot();}
 private flush(v:Viewer){
  while(!v.blocked&&!v.socket.destroyed){
   if(v.snapshot){
    const state=v.snapshot,end=Math.min(state.bytes.length,state.offset+SLICE);
    v.blocked=!v.socket.write(state.bytes.subarray(state.offset,end));state.offset=end;
    if(end===state.bytes.length)v.snapshot=undefined;
   }else if(v.resync){
    v.resync=false;v.blocked=!v.socket.write(wire(FrameType.resync,{}));
    v.snapshot={bytes:this.freshSnapshot(),offset:0};
   }else if(v.pending.length){
    const bytes=v.pending.shift()!;v.bytes-=bytes.length;v.blocked=!v.socket.write(bytes);
   }else{
    if(v.exitCode!==undefined){v.socket.end(wire(FrameType.exit,{code:v.exitCode}),v.done);v.exitCode=undefined;}
    return;
   }
  }
 }
 private send(v:Viewer,bytes:Buffer){
  if(v.socket.destroyed||v.resync)return;
  if(v.bytes+v.socket.writableLength+bytes.length>CAP){v.pending=[];v.bytes=0;v.resync=true;this.flush(v);return;}
  v.pending.push(bytes);v.bytes+=bytes.length;this.flush(v);
 }
 add(socket:Socket){
  // Even a rejected connection must never surface an unhandled socket error in the host.
  socket.on('error',()=>socket.destroy());
  if(this.closing){socket.destroy();return;}
  if(this.size>=16){socket.end(wire(FrameType.exit,{code:1,reason:'Session already has 16 viewers; detach a viewer and try again.'}));return;}
  const v:Viewer={socket,joined:false,blocked:false,pending:[],bytes:0,resync:false,label:'viewer'};
  this.viewers.add(v);this.cachedSnapshot=undefined;this.changed(this.size);const decoder=new WireDecoder();
  socket.on('close',()=>{
   this.viewers.delete(v);v.pending=[];v.snapshot=undefined;v.done?.();this.cachedSnapshot=undefined;this.changed(this.size);
   if(v.joined&&!this.closing)this.enqueue(()=>this.marker('detach',v.label));
  });
  socket.on('drain',()=>this.enqueue(()=>{v.blocked=false;this.flush(v);}));
  socket.on('data',data=>{try{for(const f of decoder.push(Buffer.from(data))){
   if(f.type===FrameType.hello&&!v.joined){
    const h=JSON.parse(f.data.toString());
    if(h.v!==1||(h.from!==undefined&&(!Number.isSafeInteger(h.from)||h.from<0))){socket.destroy();return;}
    this.enqueue(()=>{
     if(socket.destroyed||v.joined||this.closing)return;
     v.joined=true;v.label=String(h.label??'viewer').slice(0,64);
     const missing=h.from===undefined?null:this.since(h.from);
     if(missing===null){v.snapshot={bytes:this.freshSnapshot(),offset:0};this.flush(v);}
     else for(const b of missing)this.send(v,wire(FrameType.output,b));
     this.marker('attach',v.label);
    });
   }else if(f.type===FrameType.take||f.type===FrameType.release){
    this.send(v,wire(FrameType.control,{controller:null,you:false,reason:'Read-only session: control is not available.'}));
   }
  }}catch{socket.destroy();}});
 }
 broadcast(bytes:Buffer){this.cachedSnapshot=undefined;for(const v of this.viewers)if(v.joined)this.send(v,bytes);}
 destroy(){for(const v of this.viewers)v.socket.destroy();this.viewers.clear();this.cachedSnapshot=undefined;}
 async end(code:number){
  this.closing=true;
  await Promise.all([...this.viewers].map(v=>new Promise<void>(resolve=>{
   v.done=resolve;v.exitCode=code;
   if(v.socket.destroyed){resolve();return;}
   this.flush(v);
  })));
 }
}
