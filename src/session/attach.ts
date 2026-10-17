import { createConnection } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FrameType, WireDecoder, wire } from "./framing";
import { readRecording } from "./recording";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
export interface AttachOptions { replay?:boolean; attempt?:number }
export function attachDirectory(ctx:Ctx,id:string,attempt?:number):string {
  const task=readTask(ctx,id);if(!task) throw Error(`unknown task ${id}`);
  if(task.run?.host) throw Error("Remote session recording is not available in phase 1");
  const root=join(ctx.pacerHome,"runs",id);
  const n=attempt ?? (task.run?.attempt || Math.max(...readdirSync(root).filter(n=>/^\d+$/.test(n)).map(Number)));
  if(!Number.isSafeInteger(n) || n<1) throw Error("invalid session attempt");
  const dir=join(root,String(n));
  if(!existsSync(join(dir,"session.log")) && !existsSync(join(dir,"session.ckpt"))) throw Error("This attempt has no PTY recording (enable execution.session: pty)");
  return dir;
}
/** A local, read-only viewer. Raw mode and listeners are restored on every exit path. */
export async function attachSession(dir:string,options:AttachOptions={},label="pacer"):Promise<void> {
  const stdin=process.stdin, stdout=process.stdout, wasRaw=stdin.isRaw, wasPaused=stdin.isPaused();
  let detach!:()=>void;
  let didDetach=false;
  const detached=new Promise<void>(resolve=>{detach=()=>{didDetach=true;resolve();};});
  const input=(data:Buffer)=>{if(data.includes(3) || data.includes(113)) detach();};
  const stop=()=>detach();
  const draw=(type:number,data:Buffer)=>{
    if(type===FrameType.snapshot) {
      const snapshot=JSON.parse(data.toString());
      stdout.write(`\x1b[0m\x1b[2J\x1b[H${snapshot.scrollbackAnsi}${snapshot.screenAnsi}`);
      if(stdout.isTTY && (stdout.columns<snapshot.cols || stdout.rows<snapshot.rows)) process.stderr.write(`\nSession is ${snapshot.cols}×${snapshot.rows}; enlarge the viewer to see it all.\n`);
    }
    if(type===FrameType.output) stdout.write(data);
    if(type===FrameType.exit) detach();
  };
  if(stdin.isTTY) {stdin.setRawMode(true);stdin.resume();stdin.on("data",input);}
  process.on("SIGINT",stop);process.on("SIGTERM",stop);
  if(stdout.isTTY) stdout.write(`\x1b]0;${label.replace(/[\x00-\x1f\x7f]/g,"")} · watching\x07`);
  try {
    if(!options.replay && !existsSync(join(dir,"exit"))) {
      const path=existsSync(join(dir,"session.sock.path"))?readFileSync(join(dir,"session.sock.path"),"utf8"):join(dir,"session.sock");
      const socket=createConnection(path);const decoder=new WireDecoder();
      try {
        await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
        socket.on("data",data=>{try {for(const f of decoder.push(Buffer.from(data))) draw(f.type,f.data);}catch{detach();}});
        socket.on("close",detach);socket.on("error",detach);
        socket.write(wire(FrameType.hello,{v:1,client:"cli",label:"cli",cols:stdout.columns ?? 120,rows:stdout.rows ?? 40}));
        await detached;return;
      } catch { /* a dead host still has an offline recording */ }
      finally {socket.destroy();}
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
    process.off("SIGINT",stop);process.off("SIGTERM",stop);
    if(stdin.isTTY) {stdin.off("data",input);stdin.setRawMode(wasRaw ?? false);if(wasPaused) stdin.pause();}
    if(stdout.isTTY) stdout.write("\x1b[0m\x1b[?25h");
  }
}
