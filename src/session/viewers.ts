import type { Socket } from 'node:net';
import { FrameType, WireDecoder, wire, type Frame } from './framing';
import { negotiate, parseVersions } from './protocol';
import { stripQueryReplies } from './queries';
const CAP=1024*1024, SLICE=64*1024, CURSOR_REPORT_MS=2000;
interface Viewer {
 socket:Socket; joined:boolean; blocked:boolean; pending:Buffer[]; bytes:number; resync:boolean; label:string;
 snapshot?:{bytes:Buffer;offset:number}; exitCode?:number; done?:()=>void; negotiate?:boolean;
 /** Negotiated protocol minor, 1 without a hello range. */
 minor:number; readOnly:boolean; took:boolean; size?:{cols:number;rows:number};
}
/** Bounded output queues. Snapshot state is shared, and streamed in small writes. */
export interface ControlHandlers { release?:(label:string)=>void; input:(bytes:Buffer)=>void; resize:(cols:number,rows:number)=>void }
export class ViewerHub {
 private holder:Viewer|null=null;
 private current:Viewer|null=null;
 private author:Viewer|null=null;
 private cursorReportUntil=0;
 get controller(){return this.holder?.label??null;}
 /** The client that most recently typed or focused; only 1.2 hosts track it. */
 get active(){return this.current?.label??null;}
 private viewers=new Set<Viewer>();
 private pending=new Set<Viewer>();
 private cachedSnapshot?:Buffer;
 private closing=false;
 get size(){return this.viewers.size;}
 constructor(private snapshot:()=>Buffer,private since:(from:number)=>Buffer[]|null,
  private enqueue:(fn:()=>void)=>void,private marker:(kind:string,label:string)=>void=()=>{},private changed:(viewers:number,controller:string|null,active:string|null)=>void=()=>{},
  private control?:ControlHandlers,private protocol?:{pacer:string;versions:readonly [number,number]}){}
 /** A 1.2 host has no controller: every viewer that is not read-only can type (ADR 0023). */
 private get shared(){return (this.protocol?.versions[1]??1)>=2;}
 /** The host answered a cursor position query; clients' reports of it are stripped for a short window. */
 answeredCursorReport(){this.cursorReportUntil=Date.now()+CURSOR_REPORT_MS;}
 private publish(){this.changed(this.size,this.controller,this.active);}
 private state(v:Viewer,reason?:string){
  const reply=v.negotiate&&this.protocol?{versions:[...this.protocol.versions],pacer:this.protocol.pacer}:{};
  v.negotiate=false;
  const you=this.shared?(v.minor>=2?!v.readOnly:v.took):this.holder===v;
  return wire(FrameType.control,{controller:this.controller,you,...(reason?{reason}:{}),...reply});
 }
 private setController(v:Viewer|null,reason:string){
  const old=this.holder;if(old===v)return;
  this.holder=v;this.cachedSnapshot=undefined;
  if(old)this.marker('control-released',old.label);
  if(v)this.marker('control-taken',v.label);
  this.publish();
  for(const viewer of this.viewers)this.send(viewer,this.state(viewer,reason));
 }
 private activate(v:Viewer){
  if(this.current===v)return;
  this.current=v;this.cachedSnapshot=undefined;this.publish();
  if(v.size)this.control?.resize(v.size.cols,v.size.rows);
 }
 private freshSnapshot(){return this.cachedSnapshot??=this.snapshot();}
 private flush(v:Viewer){
  while(!v.blocked&&!v.socket.destroyed){
   if(v.snapshot){
    const state=v.snapshot,end=Math.min(state.bytes.length,state.offset+SLICE);
    v.blocked=!v.socket.write(state.bytes.subarray(state.offset,end));state.offset=end;
    if(end===state.bytes.length)v.snapshot=undefined;
   }else if(v.resync){
    v.resync=false;v.blocked=!v.socket.write(wire(FrameType.resync,{}));
    v.snapshot={bytes:Buffer.concat([this.freshSnapshot(),this.state(v)]),offset:0};
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
  const v:Viewer={socket,joined:false,blocked:false,pending:[],bytes:0,resync:false,label:'viewer',minor:1,readOnly:false,took:false};
  this.pending.add(v);
  const helloTimer=setTimeout(()=>socket.destroy(),5000);helloTimer.unref();
  const decoder=new WireDecoder();
  socket.on('close',()=>{
   clearTimeout(helloTimer);this.pending.delete(v);
   const joined=this.viewers.delete(v);v.pending=[];v.snapshot=undefined;v.done?.();
   if(this.holder===v)this.setController(null,'disconnected');
   if(this.author===v)this.author=null;
   if(this.current===v)this.current=null;
   if(joined){this.cachedSnapshot=undefined;this.publish();}
   if(v.joined&&!this.closing)this.enqueue(()=>this.marker('detach',v.label));
  });
  socket.on('drain',()=>this.enqueue(()=>{v.blocked=false;this.flush(v);}));
  socket.on('data',data=>{try{for(const f of decoder.push(Buffer.from(data))){
   if(f.type===FrameType.hello&&!v.joined){
    const h=JSON.parse(f.data.toString());
    const versions=h.versions===undefined?null:parseVersions(h.versions);
    if(h.v!==1||(h.from!==undefined&&(!Number.isSafeInteger(h.from)||h.from<0))||(h.versions!==undefined&&!versions)){socket.destroy();return;}
    clearTimeout(helloTimer);
    this.enqueue(()=>{
     if(socket.destroyed||v.joined||this.closing)return;
     const minor=negotiate(versions,this.protocol?.versions??[1,1]);
     if(minor===null){socket.end(wire(FrameType.exit,{code:1,reason:'This session runs on an older pacer. Reopen to update.'}));return;}
     if(this.size>=16){socket.end(wire(FrameType.exit,{code:1,reason:'Session already has 16 viewers; detach a viewer and try again.'}));return;}
     this.pending.delete(v);this.viewers.add(v);v.joined=true;v.negotiate=!!versions&&!!this.protocol;
     v.minor=minor;v.readOnly=h.readOnly===true;
     v.label=`${h.client==='app'?'app':'cli'}:${String(h.label??'viewer').replace(/[\x00-\x1f\x7f]/g,'').slice(0,64)}`;
     this.cachedSnapshot=undefined;this.publish();
     const missing=h.from===undefined?null:this.since(h.from);
     if(missing===null){v.snapshot={bytes:Buffer.concat([this.freshSnapshot(),this.state(v)]),offset:0};this.flush(v);}
     else {for(const b of missing)this.send(v,wire(FrameType.output,b));this.send(v,this.state(v));}
     this.marker('attach',v.label);
    });
   }else if(f.type===FrameType.take||f.type===FrameType.release||f.type===FrameType.input||f.type===FrameType.size||f.type===FrameType.focus){
    // Serialize admission, control and PTY actions with output/snapshot updates.
    this.enqueue(()=>{
     if(!v.joined||socket.destroyed||this.closing)return;
     try {if(this.shared)this.sharedFrame(v,f);else this.controllerFrame(v,f);}
     catch{socket.destroy();}
    });
   }
  }}catch{socket.destroy();}});
 }
 /** Session protocol 1.1: one controller; only its input and size reach the PTY. */
 private controllerFrame(v:Viewer,f:Frame){
  if(f.type===FrameType.take){
   const body=JSON.parse(f.data.toString());
   if(this.holder===v)this.send(v,this.state(v));
   else if(!this.holder||body.force===true)this.setController(v,'taken');
   else this.send(v,this.state(v,'refused'));
  }else if(f.type===FrameType.release){
   if(this.holder===v){this.setController(null,'released');this.control?.release?.(v.label);}
  }else if(f.type===FrameType.focus||this.holder!==v)return;
  else if(f.type===FrameType.input){if(f.data.length)this.control?.input(f.data);}
  else {const size=dimensions(f.data);if(size)this.control?.resize(size.cols,size.rows);}
 }
 /**
  * Session protocol 1.2: no controller. A 1.1 client types only between its take, which is always granted and makes
  * it active, and its release, which still hands back a takeover. The PTY size follows the most recently active client.
  */
 private sharedFrame(v:Viewer,f:Frame){
  if(f.type===FrameType.take){
   JSON.parse(f.data.toString());
   if(v.readOnly){this.send(v,this.state(v,'read-only'));return;}
   v.took=true;this.send(v,this.state(v));this.activate(v);
  }else if(f.type===FrameType.release){
   if(!v.took)return;
   v.took=false;this.send(v,this.state(v,'released'));
   if(v.minor<2)this.control?.release?.(v.label);
  }else if(v.readOnly||(v.minor<2&&!v.took))return;
  else if(f.type===FrameType.input){
   const bytes=stripQueryReplies(f.data,Date.now()<this.cursorReportUntil);
   if(!bytes.length)return;
   if(this.author!==v){this.author=v;this.marker('input',v.label);}
   this.activate(v);this.control?.input(bytes);
  }else if(f.type===FrameType.focus)this.activate(v);
  else {
   const size=dimensions(f.data);if(!size)return;
   v.size=size;if(this.current===v)this.control?.resize(size.cols,size.rows);
  }
 }
 broadcast(bytes:Buffer){this.cachedSnapshot=undefined;for(const v of this.viewers)if(v.joined)this.send(v,bytes);}
 destroy(){for(const v of [...this.pending,...this.viewers])v.socket.destroy();this.pending.clear();this.viewers.clear();this.holder=null;this.current=null;this.author=null;this.cachedSnapshot=undefined;this.changed(0,null,null);}
 async end(code:number){
  this.closing=true;
  this.setController(null,'ended');
  this.current=null;
  this.changed(this.size,null,null);
  for(const v of this.pending)v.socket.destroy();
  await Promise.all([...this.viewers].map(v=>new Promise<void>(resolve=>{
   v.done=resolve;v.exitCode=code;
   if(v.socket.destroyed){resolve();return;}
   this.flush(v);
  })));
 }
}
function dimensions(data:Buffer){
 const {cols,rows}=JSON.parse(data.toString());
 return [cols,rows].every(n=>Number.isInteger(n)&&n>0)&&cols<=1000&&rows<=500?{cols:cols as number,rows:rows as number}:null;
}
