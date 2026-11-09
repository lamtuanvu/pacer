import { platform } from "../platform";
/** Browser-only session v1 frame client. No terminal dependency in the app bundle. */
export interface SessionSocket {
 readyState:number; binaryType:string;
 onopen:(()=>void)|null; onclose:(()=>void)|null; onerror:(()=>void)|null;
 onmessage:((event:{data:unknown})=>void)|null;
 send(data:string|Uint8Array):void; close():void;
}
export interface TerminalSnapshot { outputOffset:number; cols:number; rows:number; scrollbackAnsi:string; screenAnsi:string; controller:string|null; viewers:number }
/** shared is true once a host negotiated session protocol 1.2, which has no controller (ADR 0023). */
export interface SessionState { status:'connecting'|'live'|'reconnecting'|'resyncing'|'exited'|'error'; you:boolean; controller:string|null; cols:number; rows:number; viewers:number; shared?:boolean; delivered?:Delivery; active?:string|null; code?:number; signal?:string; message?:string }
/** The last input pacer typed into a 1.2 session, from the host's delivered broadcast (ADR 0023). */
export interface Delivery { kind:'answer'|'message'; label?:string }
export interface SessionClientOptions {
 url:string; label:string; cols:number; rows:number; control:boolean; autoControl?:boolean;
 from?:number;
 socket?:(url:string)=>SessionSocket;
 schedule?:(fn:()=>void,ms:number)=>(()=>void);
 onSnapshot?:(snapshot:TerminalSnapshot)=>void; onOutput?:(bytes:Uint8Array)=>void;
 onState?:(state:SessionState)=>void;
}
/** Mirrors SESSION_PROTOCOL in src/session/protocol.ts, which the browser bundle cannot import. */
export const SESSION_VERSIONS:readonly [number,number]=[1,2];
/** The minor version a host's first control frame agrees to; a host without a range speaks 1.1. */
export function negotiatedMinor(host:unknown):number{
 const range=Array.isArray(host)&&host.length===2&&host.every(n=>Number.isInteger(n)&&n>0)&&host[0]<=host[1]?host as [number,number]:[1,1];
 const top=Math.min(SESSION_VERSIONS[1],range[1]);
 return top>=Math.max(SESSION_VERSIONS[0],range[0])?top:1;
}
export class SessionClient {
 state:SessionState;
 private ws?:SessionSocket; private offset?:number; private stopped=false; private ended=false; private attempt=0; private cancel?:()=>void;
 private autoControlAllowed:boolean; private autoControlAttempted=false;
 /** The host's last answer to whether this viewer may type; 1.2 grants it without take. */
 private hostYou=false;
 /** The minor version of the current connection, decided by its first control frame. */
 private minor?:number;
 constructor(private options:SessionClientOptions){this.offset=options.from;this.autoControlAllowed=options.autoControl!==false;this.state={status:'connecting',you:false,controller:null,cols:options.cols,rows:options.rows,viewers:0};}
 private update(patch:Partial<SessionState>){if(Object.entries(patch).every(([key,value])=>this.state[key as keyof SessionState]===value))return;this.state={...this.state,...patch};this.options.onState?.(this.state);}
 /** Until a reconnect is decided, the last host's mode holds, so take and release stay off a 1.2 session. */
 private get shared(){return this.minor===undefined?this.state.shared===true:this.minor>=2;}
 connect(){
  if(this.stopped||this.ended)return;
  this.autoControlAttempted=false;this.minor=undefined;
  this.update({status:this.attempt?'reconnecting':'connecting',you:false});
  let ws:SessionSocket;
  try{ws=(this.options.socket??platform.attachTerminal)(this.offset===undefined?this.options.url:`${this.options.url}${this.options.url.includes('?')?'&':'?'}from=${this.offset}`);}catch{this.retry();return;}
  this.ws=ws;ws.binaryType='arraybuffer';
  ws.onopen=()=>{if(this.ws!==ws||this.stopped)return;this.send('hello',{v:1,versions:[...SESSION_VERSIONS],client:'app',label:this.options.label,cols:this.state.cols,rows:this.state.rows,...(this.offset===undefined?{}:{from:this.offset})});};
  ws.onmessage=event=>{if(this.ws!==ws||this.stopped)return;try{this.receive(event.data);}catch{this.update({status:'error',you:false,message:'Could not read the session stream.'});ws.close();}};
  ws.onerror=()=>{if(this.ws===ws&&!this.stopped)this.update({message:'Session connection interrupted.'});};
  ws.onclose=()=>{if(this.ws!==ws||this.stopped||this.ended)return;this.ws=undefined;this.update({you:false,controller:null});this.retry();};
 }
 private retry(){
  this.update({status:'reconnecting',you:false});const ms=Math.min(500*2**this.attempt++,5000);
  this.cancel=(this.options.schedule??((fn,ms)=>{const id=setTimeout(fn,ms);return ()=>clearTimeout(id);} ))(()=>this.connect(),ms);
 }
 private send(type:string,body:Record<string,unknown>={}){if(this.ws?.readyState!==1||this.stopped||this.ended)return false;this.ws.send(JSON.stringify({type,...body}));return true;}
 private receive(data:unknown){
  if(typeof data==='string'){
   const frame=JSON.parse(data);
   switch(frame.type){
    case 'snapshot': {
     if(!Number.isSafeInteger(frame.outputOffset)||frame.outputOffset<0||!Number.isInteger(frame.cols)||frame.cols<1||!Number.isInteger(frame.rows)||frame.rows<1||typeof frame.scrollbackAnsi!=='string'||typeof frame.screenAnsi!=='string')throw Error('invalid snapshot');
     this.options.onSnapshot?.(frame);this.offset=frame.outputOffset;this.attempt=0;
     this.update({status:'live',cols:frame.cols,rows:frame.rows,controller:frame.controller,viewers:frame.viewers,you:false,message:undefined,...(typeof frame.active==='string'||frame.active===null?{active:frame.active}:{})});
     this.tryAutoControl();
     break;
    }
    case 'resize':if(Number.isInteger(frame.cols)&&frame.cols>0&&Number.isInteger(frame.rows)&&frame.rows>0)this.update({cols:frame.cols,rows:frame.rows});break;
    case 'control':{
     // Only the first control frame of a connection carries the host's version range.
     this.minor??=negotiatedMinor(frame.versions);
     const shared=this.minor>=2;this.hostYou=frame.you===true;
     this.attempt=0;this.update({...(this.offset!==undefined&&this.state.status!=='resyncing'?{status:'live' as const}:{}),controller:shared?null:frame.controller,...(Number.isInteger(frame.viewers)?{viewers:frame.viewers}:{}),you:this.options.control&&this.hostYou,shared,message:!shared&&frame.reason==='taken'&&!frame.you?'Control was taken by another viewer.':undefined,...(typeof frame.active==='string'||frame.active===null?{active:frame.active}:{})});this.tryAutoControl();break;
    }
    // 1.2 hosts broadcast pacer's own input; granted belongs to the deliverer, never a viewer, and is ignored.
    case 'delivered':if(this.shared&&frame.ok===true){const label=typeof frame.label==='string'?frame.label:undefined;this.update({delivered:{kind:frame.kind==='answer'||frame.kind!=='message'&&/answer/i.test(label??'')?'answer':'message',...(label?{label}:{})}});}break;
    case 'granted':break;
    case 'resync':this.offset=undefined;this.update({status:'resyncing',you:false,message:'Refreshing the terminal snapshot…'});break;
    case 'exit':this.ended=true;this.cancel?.();this.update({status:'exited',you:false,code:frame.code,signal:frame.signal,message:undefined});break;
    default:throw Error('unknown session frame');
   }
   return;
  }
  const bytes=data instanceof ArrayBuffer?new Uint8Array(data):data instanceof Uint8Array?data:null;
  if(!bytes)throw Error('invalid binary frame');
  let at=0;
  while(at<bytes.length){
   if(at+5>bytes.length)throw Error('incomplete output');
   const length=new DataView(bytes.buffer,bytes.byteOffset+at+1,4).getUint32(0);
   if(bytes[at]!==3||length>16*1024*1024||at+5+length>bytes.length)throw Error('invalid output');
   if(this.offset===undefined)throw Error('output before snapshot');
   this.options.onOutput?.(bytes.subarray(at+5,at+5+length));this.offset+=length;at+=5+length;
  }
  this.attempt=0;this.update({status:'live',message:undefined});
 }
 private tryAutoControl(){
  // A resume with no new output has only a control frame, not a snapshot.
  // Attempt once per connection, and never retry because another viewer releases.
  // Wait for the host's version: a 1.2 host never receives take.
  if(this.minor!==1||this.offset===undefined||this.state.status!=='live'||this.autoControlAttempted)return;
  this.autoControlAttempted=true;
  if(this.state.controller===null&&this.autoControlAllowed)void this.take();
 }
 async take(confirm?:(message:string)=>boolean|Promise<boolean>){
  if(!this.options.control||this.shared||this.state.you||this.ended||this.state.status!=='live')return false;
  const holder=this.state.controller;
  if(holder){if(!confirm||!await confirm(`Someone is in control from ${holder}. Take over?`))return false;
   // A delayed confirmation must not steal control from a different holder.
   if(this.state.controller!==holder||this.state.you||this.state.status!=='live')return false;
   const sent=this.send('take',{force:true});if(sent)this.autoControlAllowed=true;return sent;}
  const sent=this.send('take');if(sent)this.autoControlAllowed=true;return sent;
 }
 release(){if(this.shared)return false;this.autoControlAllowed=false;const sent=this.send('release');this.update({you:false});return sent;}
 /** On a 1.2 host, makes this pane the active client so the PTY follows its size. */
 focus(){return this.minor!==undefined&&this.minor>=2&&this.options.control&&this.state.you?this.send('focus'):false;}
 input(text:string){
  if(!this.options.control||!this.state.you||this.ws?.readyState!==1||this.stopped||this.ended)return false;
  const data=new TextEncoder().encode(text),bytes=new Uint8Array(5+data.length);bytes[0]=10;new DataView(bytes.buffer).setUint32(1,data.length);bytes.set(data,5);this.ws.send(bytes);if(this.state.delivered)this.update({delivered:undefined});return true;
 }
 resize(cols:number,rows:number){return this.state.you&&this.options.control?this.send('size',{cols,rows}):false;}
 get outputOffset(){return this.offset;}
 configure(control:boolean,autoControl?:boolean,metadata:Partial<Pick<SessionClientOptions,'url'|'label'>>={}){Object.assign(this.options,metadata);this.options.control=control;if(autoControl!==undefined&&!this.autoControlAttempted)this.autoControlAllowed=autoControl;
  // 1.2 sends no further control frame: a pane that connected before its task went live follows control from here.
  if(this.shared&&this.state.status==='live'){if(this.state.you!==(control&&this.hostYou))this.update({you:control&&this.hostYou});return;}
  if(!control&&this.state.you)this.release();}
 dispose(){this.stopped=true;this.cancel?.();if(this.ws){this.ws.onopen=this.ws.onmessage=this.ws.onclose=this.ws.onerror=null;this.ws.close();}this.ws=undefined;}
}
