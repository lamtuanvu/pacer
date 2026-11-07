import { clientHello, negotiate, parseVersions, SESSION_PROTOCOL } from "./protocol";
import { createConnection } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { admitRemoteViewer } from "../remote/viewer-admission";
import { FrameType, WireDecoder, wire } from "./framing";
import { readRecording } from "./recording";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
/** control and force apply only to 1.1 hosts. readOnly never sends input, size, focus or take. */
export interface AttachOptions { replay?:boolean; attempt?:number; control?:boolean; force?:boolean; readOnly?:boolean }
/** Stateful byte parser: escape sequences may cross stdin chunks. */
export class AttachKeys {
  private controlling=false;
  private shared=false;
  private escaped=false;
  private terminalEscape: 'esc'|'csi'|'ss3'|'string'|'stringEsc'|null=null;
  private requested=false;
  private confirming=false;
  constructor(private send:(bytes:Buffer)=>void,private prompt:(message:string)=>void=()=>{},private takeover=false,private readOnly=false){}
  take(force=false){if(this.readOnly||this.shared)return;this.requested=true;this.send(wire(FrameType.take,force?{force:true}:{}));}
  /** A 1.2 host has no controller: keys go straight to the agent unless the viewer is read-only. */
  sharedHost(){this.shared=true;this.requested=false;this.confirming=false;this.setControl(!this.readOnly);}
  controlState(state:{you?:boolean;controller?:string|null;reason?:string}){
    if(this.shared)return;
    this.setControl(state.you===true&&!this.readOnly);
    if(this.requested && (state.you||state.reason==='refused')){
      this.requested=false;
      if(!state.you&&state.controller){
        this.confirming=true;
        this.prompt(`Someone is in control from ${state.controller.replace(/[\x00-\x1f\x7f]/g,'')}. Take over? [y/N] `);
      }
    }
    if(state.you||!state.controller)this.confirming=false;
  }
  setControl(you:boolean){if(this.controlling!==you)this.escaped=false;this.controlling=you;}
  push(data:Buffer):boolean {
    const pending:number[]=[];
    const flush=()=>{if(pending.length){this.send(wire(FrameType.input,Buffer.from(pending)));pending.length=0;}};
    for(const byte of data){
      if(!this.controlling){
        // Terminal replies are protocol bytes, including when split across chunks.
        if(this.terminalEscape){
          const state=this.terminalEscape;
          if(state==='esc')this.terminalEscape=byte===91?'csi':byte===79?'ss3':[93,80,94,95,88].includes(byte)?'string':byte>=0x30&&byte<=0x7e?null:'esc';
          else if(state==='csi'||state==='ss3'){if(byte>=0x40&&byte<=0x7e)this.terminalEscape=null;}
          else if(byte===7||(state==='stringEsc'&&byte===92))this.terminalEscape=null;
          else this.terminalEscape=byte===27?'stringEsc':'string';
          continue;
        }
        if(byte===27){this.terminalEscape='esc';continue;}
        if(this.confirming){this.confirming=false;this.prompt('\n');if(byte===121||byte===89)this.take(true);continue;}
        if(byte===113||byte===3)return true;
        if(byte===99)this.take();
      }else if(this.escaped){
        this.escaped=false;
        if(byte===100){flush();return true;}
        if(byte===114&&this.shared){flush();this.prompt(this.takeover?"Hand the task back from the pacer app.\n":"Every attached terminal can type; there is no control to release.\n");}
        else if(byte===114){flush();if(this.takeover)this.prompt("Releasing hands the task back for review.\n");this.send(wire(FrameType.release,{}));}
        else if(byte===29)pending.push(29);
        else pending.push(29,byte);
      }else if(byte===29){flush();this.escaped=true;}
      else pending.push(byte);
    }
    flush();return false;
  }
}
export function attachDirectory(ctx:Ctx,id:string,attempt?:number):string {
  const task=readTask(ctx,id);if(!task) throw Error(`unknown task ${id}`);
  const root=join(ctx.pacerHome,"runs",id);
  const n=attempt ?? (task.run?.attempt || Math.max(...readdirSync(root).filter(n=>/^\d+$/.test(n)).map(Number)));
  if(!Number.isSafeInteger(n) || n<1) throw Error("invalid session attempt");
  const dir=task.run?.dir && (attempt===undefined || attempt===task.run.attempt)?task.run.dir:join(root,String(n));
  if(!existsSync(join(dir,"session.log")) && !existsSync(join(dir,"session.ckpt"))) throw Error("This attempt has no PTY recording (enable execution.session: pty)");
  return dir;
}
/** Render a protocol frame; true means the viewer should detach. */
export function renderSessionFrame(type:number,data:Buffer,stdout:NodeJS.WriteStream=process.stdout,stderr:NodeJS.WriteStream=process.stderr):boolean{
    if(type===FrameType.snapshot) {
      const snapshot=JSON.parse(data.toString());
      stdout.write(`\x1b[0m\x1b[2J\x1b[H${snapshot.scrollbackAnsi}${snapshot.screenAnsi}`);
      if(stdout.isTTY && (stdout.columns<snapshot.cols || stdout.rows<snapshot.rows)) stderr.write(`\nSession is ${snapshot.cols}×${snapshot.rows}; enlarge the viewer to see it all.\n`);
    }
    if(type===FrameType.output) stdout.write(data);
    if(type===FrameType.exit){
      const exit=JSON.parse(data.toString());
      if(typeof exit.reason==='string')stderr.write(`${exit.reason.replace(/[\x00-\x1f\x7f]/g,'')}\n`);
      return true;
    }
    return false;
}
/** A local viewer. Raw mode and listeners are restored on every exit path. */
export async function attachSession(dir:string,options:AttachOptions={},label="pacer"):Promise<void> {
  const stdin=process.stdin, stdout=process.stdout, wasRaw=stdin.isRaw, wasPaused=stdin.isPaused();
  let detach!:()=>void;
  let didDetach=false;
  const detached=new Promise<void>(resolve=>{detach=()=>{didDetach=true;resolve();};});
  let send:(bytes:Buffer)=>void=()=>{};
  let controlling=false;
  let takeover=false;
  const readOnly=options.readOnly===true;
  // Decided by the host's first control frame: true on a host that negotiated 1.2.
  let shared:boolean|undefined;
  try{takeover=JSON.parse(readFileSync(join(dir,"session.json"),"utf8")).takeover===true;}catch{/* optional metadata */}
  const keys=new AttachKeys(bytes=>send(bytes),message=>process.stderr.write(message),takeover,readOnly);
  const input=(data:Buffer)=>{if(keys.push(data))detach();};
  const title=()=>{if(stdout.isTTY)stdout.write(`\x1b]0;${label.replace(/[\x00-\x1f\x7f]/g,"")} · ${controlling?(shared?'interactive':'controlling'):'watching'}\x07`);};
  const resize=()=>{if(controlling)send(wire(FrameType.size,{cols:stdout.columns??120,rows:stdout.rows??40}));};
  const stop=()=>detach();
  const draw=(type:number,data:Buffer)=>{
    if(type===FrameType.control&&shared===undefined){
      const state=JSON.parse(data.toString());
      shared=(negotiate(SESSION_PROTOCOL,parseVersions(state.versions)??[1,1])??1)>=2;
      if(shared){
        keys.sharedHost();controlling=!readOnly;title();
        // 1.2-only frames go only to a host that negotiated 1.2.
        if(controlling){send(wire(FrameType.focus,{}));resize();}
      }else if(options.control&&!readOnly)keys.take(options.force);
    }
    if(type===FrameType.control&&!shared){
      const state=JSON.parse(data.toString()),wasControlling=controlling;
      controlling=state.you===true&&!readOnly;title();
      if(controlling&&!wasControlling)resize();
      if(!controlling&&state.controller&&state.reason!=='refused')process.stderr.write(`Control is held from ${String(state.controller).replace(/[\x00-\x1f\x7f]/g,'')}.\n`);
      keys.controlState(state);
    }
    if(renderSessionFrame(type,data,stdout))detach();
  };
  if(stdin.isTTY) {stdin.setRawMode(true);stdin.resume();stdin.on("data",input);}
  process.on("SIGINT",stop);process.on("SIGTERM",stop);
  title();stdout.on("resize",resize);
  try {
    if(!options.replay && !existsSync(join(dir,"exit"))) {
      const path=existsSync(join(dir,"session.sock.path"))?readFileSync(join(dir,"session.sock.path"),"utf8"):join(dir,"session.sock");
      const socket=createConnection(path);const decoder=new WireDecoder();
      try {
        await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
        if(existsSync(join(dir,"session.bridge.pid"))){
          const reason=await admitRemoteViewer(socket);
          if(reason) throw Error(reason);
        }
        socket.on("data",data=>{try {for(const f of decoder.push(Buffer.from(data))) draw(f.type,f.data);}catch{detach();}});
        socket.on("close",detach);socket.on("error",detach);
        socket.resume();
        send=bytes=>{if(!socket.destroyed)socket.write(bytes);};
        send(wire(FrameType.hello,{v:1,client:"cli",label:process.env.TERM_PROGRAM??process.env.TERM??"cli",cols:stdout.columns ?? 120,rows:stdout.rows ?? 40,...clientHello(),...(readOnly?{readOnly:true}:{})}));
        await detached;return;
      } catch (error) {
        if(existsSync(join(dir,"session.bridge.pid"))) throw error;
        /* a dead host still has an offline recording */
      }
      finally {send=()=>{};socket.destroy();}
    }
    // Replay starts with the last checkpoint, then the retained current generation.
    const {checkpoint,frames}=readRecording(dir);
    if(checkpoint) draw(FrameType.snapshot,Buffer.from(JSON.stringify(checkpoint)));
    let previous=frames[0]?.ms ?? 0;
    for(const frame of frames) {
      if(options.replay) {await Promise.race([Bun.sleep(Math.max(0,(frame.ms ?? previous)-previous)),detached]);previous=frame.ms ?? previous;}
      // A detach during replay stops without waiting for the rest of the log.
      if(didDetach) break;
      if(frame.type===1) draw(FrameType.output,frame.data);
    }
  } finally {
    stdout.off("resize",resize);
    process.off("SIGINT",stop);process.off("SIGTERM",stop);
    if(stdin.isTTY) {stdin.off("data",input);stdin.setRawMode(wasRaw ?? false);if(wasPaused) stdin.pause();}
    if(stdout.isTTY) stdout.write("\x1b[0m\x1b[?25h");
  }
}
