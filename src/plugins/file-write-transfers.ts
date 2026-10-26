import {randomUUID} from 'node:crypto';
import {CallAuthority} from './authority';
import {CoreError} from '../core/errors';
const MAX=4194304,CHUNK=262144;
type Callbacks={authorize(path:string):void|Promise<void>;write(path:string,text:string,mode?:number):Promise<{ok:true}>};
type Fits=(value:unknown)=>boolean;
interface Body {handle:string;path:string;mode?:number;buffer:Buffer;offset:number}
const denied=()=>new CoreError('capability_denied','file write handle is not owned by this active call');
const invalid=()=>new CoreError('invalid_input','invalid file write transfer');
class FileWriteTransfers {
 private body?:Body;
 private retired?:string;
 private busy=false;
 private finished?:Promise<void>;
 constructor(private owner:CallAuthority,private callbacks:Callbacks){
  owner.onRevoke(()=>{this.clear();this.retired=undefined;return this.finished;});
 }
 private clear(){this.body?.buffer.fill(0);this.body=undefined;}
 private guard(){this.owner.assertGranted('fs.write');}
 private payload(handle:string){this.guard();if(!this.body||this.body.handle!==handle)throw denied();return this.body;}
 private preflight(value:unknown,fits?:Fits){
  try{if(fits&&fits(value)!==true)throw invalid();}catch{throw invalid();}
  this.guard();
 }
 private async run<T>(action:()=>Promise<T>):Promise<T>{
  this.guard();if(this.busy)throw new CoreError('conflict','one file write transfer operation is already active');
  this.busy=true;let settle!:()=>void;
  this.finished=new Promise<void>(resolve=>{settle=resolve;});
  try{const result=await action();this.guard();return result;}
  finally{this.busy=false;this.finished=undefined;settle();}
 }
 begin(path:string,bytes:number,mode?:number,fits?:Fits){return this.run(async()=>{
  if(this.body)throw new CoreError('conflict','one pending file write is already reserved');
  if(typeof path!=='string'||!path||path.length>4096||path.includes('\0')||!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX||mode!==undefined&&mode!==0o600)throw invalid();
  await this.callbacks.authorize(path);this.guard();
  const result={handle:randomUUID()};this.preflight(result,fits);
  this.body={handle:result.handle,path,mode,buffer:Buffer.alloc(bytes),offset:0};return result;
 });}
 append(handle:string,offset:number,base64:string,fits?:Fits){return this.run(async()=>{
  const body=this.payload(handle);
  if(!Number.isSafeInteger(offset)||offset!==body.offset||typeof base64!=='string'||!base64||base64.length>349528)throw invalid();
  const bytes=Buffer.from(base64,'base64');
  if(bytes.length>CHUNK||bytes.toString('base64')!==base64||offset+bytes.length>body.buffer.length)throw invalid();
  const result={bytes:offset+bytes.length};this.preflight(result,fits);
  if(this.body!==body)throw denied();
  bytes.copy(body.buffer,offset);body.offset=result.bytes;return result;
 });}
 commit(handle:string){return this.run(async()=>{
  const body=this.payload(handle);if(body.offset!==body.buffer.length)throw invalid();
  try{
   await this.callbacks.authorize(body.path);this.guard();
   let text:string;
   try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body.buffer);}catch{throw invalid();}
   this.guard();return await this.callbacks.write(body.path,text,body.mode);
  }finally{if(this.body===body){this.retired=body.handle;this.clear();}}
 });}
 release(handle:string){return this.run(async()=>{if(this.retired===handle)return {ok:true as const};this.payload(handle);this.retired=handle;this.clear();return {ok:true as const};});}
}
const instances=new WeakMap<CallAuthority,FileWriteTransfers>();
/** Exactly one bounded staging slot per owner. Callbacks are host-issued and captured once. */
export function fileWriteTransfers(owner:CallAuthority,callbacks:Callbacks){
 if(!(owner instanceof CallAuthority))throw denied();owner.assertActive();
 let instance=instances.get(owner);
 if(!instance){instance=new FileWriteTransfers(owner,callbacks);instances.set(owner,instance);}
 return instance;
}
