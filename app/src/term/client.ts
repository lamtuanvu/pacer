/** Browser-only session v1 frame client. No terminal dependency in the app bundle. */
export interface SessionSocket {
 readyState:number; binaryType:string;
 onopen:(()=>void)|null; onclose:(()=>void)|null; onerror:(()=>void)|null;
 onmessage:((event:{data:unknown})=>void)|null;
 send(data:string|Uint8Array):void; close():void;
}
export interface TerminalSnapshot { outputOffset:number; cols:number; rows:number; scrollbackAnsi:string; screenAnsi:string; controller:string|null; viewers:number }
export interface SessionState { status:'connecting'|'live'|'reconnecting'|'resyncing'|'exited'|'error'; you:boolean; controller:string|null; cols:number; rows:number; viewers:number; code?:number; signal?:string; message?:string }
export interface SessionClientOptions {
 url:string; label:string; cols:number; rows:number; control:boolean; autoControl?:boolean;
 socket?:(url:string)=>SessionSocket;
 schedule?:(fn:()=>void,ms:number)=>(()=>void);
 onSnapshot?:(snapshot:TerminalSnapshot)=>void; onOutput?:(bytes:Uint8Array)=>void;
 onState?:(state:SessionState)=>void;
}
export class SessionClient {
 state:SessionState;
 private ws?:SessionSocket; private offset?:number; private stopped=false; private ended=false; private attempt=0; private cancel?:()=>void;
 private autoControlAllowed=true; private autoControlAttempted=false;
 constructor(private options:SessionClientOptions){this.state={status:'connecting',you:false,controller:null,cols:options.cols,rows:options.rows,viewers:0};}
 private update(patch:Partial<SessionState>){this.state={...this.state,...patch};this.options.onState?.(this.state);}
 connect(){
  if(this.stopped||this.ended)return;
  this.autoControlAttempted=false;
  this.update({status:this.attempt?'reconnecting':'connecting',you:false});
  let ws:SessionSocket;
  try{ws=(this.options.socket??(url=>new WebSocket(url) as unknown as SessionSocket))(this.options.url);}catch{this.retry();return;}
  this.ws=ws;ws.binaryType='arraybuffer';
  ws.onopen=()=>{if(this.ws!==ws||this.stopped)return;this.send('hello',{v:1,versions:[1,1],client:'app',label:this.options.label,cols:this.state.cols,rows:this.state.rows,...(this.offset===undefined?{}:{from:this.offset})});};
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
     this.update({status:'live',cols:frame.cols,rows:frame.rows,controller:frame.controller,viewers:frame.viewers,you:false,message:undefined});
     if(this.options.autoControl!==false&&!this.autoControlAttempted){
      this.autoControlAttempted=true;
      if(frame.controller===null&&this.autoControlAllowed)void this.take();
     }
     break;
    }
    case 'resize':if(Number.isInteger(frame.cols)&&frame.cols>0&&Number.isInteger(frame.rows)&&frame.rows>0)this.update({cols:frame.cols,rows:frame.rows});break;
    case 'control':this.attempt=0;this.update({...(this.offset!==undefined&&this.state.status!=='resyncing'?{status:'live' as const}:{}),controller:frame.controller,you:this.options.control&&frame.you===true,message:frame.reason==='taken'&&!frame.you?'Control was taken by another viewer.':undefined});break;
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
 async take(confirm?:(message:string)=>boolean|Promise<boolean>){
  if(!this.options.control||this.state.you||this.ended||this.state.status!=='live')return false;
  const holder=this.state.controller;
  if(holder){if(!confirm||!await confirm(`Someone is in control from ${holder}. Take over?`))return false;
   // A delayed confirmation must not steal control from a different holder.
   if(this.state.controller!==holder||this.state.you||this.state.status!=='live')return false;
   return this.send('take',{force:true});}
  return this.send('take');
 }
 release(){this.autoControlAllowed=false;const sent=this.send('release');this.update({you:false});return sent;}
 input(text:string){
  if(!this.options.control||!this.state.you||this.ws?.readyState!==1||this.stopped||this.ended)return false;
  const data=new TextEncoder().encode(text),bytes=new Uint8Array(5+data.length);bytes[0]=10;new DataView(bytes.buffer).setUint32(1,data.length);bytes.set(data,5);this.ws.send(bytes);return true;
 }
 resize(cols:number,rows:number){return this.state.you&&this.options.control?this.send('size',{cols,rows}):false;}
 dispose(){this.stopped=true;this.cancel?.();if(this.ws){this.ws.onopen=this.ws.onmessage=this.ws.onclose=this.ws.onerror=null;this.ws.close();}this.ws=undefined;}
}
