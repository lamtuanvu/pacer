import { createServer, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { Recording } from "./recording";
import { FrameType, WireDecoder, wire } from "./framing";
import { SecretMasker } from "./masking";
import { killTree } from "../exec/process";
import { WRAPPER_SH } from "../supervisor/wrapper";
export interface SessionLaunch { argv:string[]; cwd:string; capBytes?:number; pacerHome?:string }
export function socketPath(dir:string):string {
  const direct=join(dir,"session.sock");
  if(Buffer.byteLength(direct) < 104) return direct;
  const root=join(tmpdir(),`pacer-${process.getuid?.() ?? "user"}`);
  mkdirSync(root,{recursive:true,mode:0o700}); chmodSync(root,0o700);
  return join(root,`${createHash("sha256").update(dir).digest("hex").slice(0,12)}.sock`);
}
export function sessionSecrets(env:NodeJS.ProcessEnv,home:string):string[] {
  const values=Object.entries(env).filter(([name])=>name.startsWith("PACER_KEY_")).map(([,v])=>v!);
  try { for(const f of readdirSync(join(home,"secrets"))) if(f.endsWith(".key")) values.push(readFileSync(join(home,"secrets",f),"utf8")); } catch { /* optional store */ }
  return values;
}
/** Detached host entry point. Configuration is prepared by startRun; no strategy reads here. */
export async function sessionHost(dir:string):Promise<number> {
  const launch=JSON.parse(readFileSync(join(dir,"session.json"),"utf8")) as SessionLaunch;
  const atomic=(name:string,value:string)=>{writeFileSync(join(dir,`${name}.tmp`),value,{mode:0o600});renameSync(join(dir,`${name}.tmp`),join(dir,name));};
  atomic("pid",String(process.pid)); atomic("started",String(Date.now()/1000));
  writeFileSync(join(dir,"stdout"),"",{mode:0o600}); writeFileSync(join(dir,"stderr"),"",{mode:0o600});
  const recording=new Recording(dir,{capBytes:launch.capBytes});
  const mask=new SecretMasker(sessionSecrets(process.env,launch.pacerHome ?? dirname(dirname(dirname(dir)))));
  let queue=Promise.resolve(), viewer:Socket|undefined, joined=false, resync=false, stopping=false;
  let terminalClosed!:()=>void;
  const closed=new Promise<void>(resolve=>{terminalClosed=resolve;});
  let recordingEnabled=true;
  const disableRecording=()=>{
    recordingEnabled=false;
    recording.disable();
    try { viewer?.destroy(); } catch { /* even error recovery must preserve the PTY */ }
  };
  process.on("uncaughtException",disableRecording);
  process.on("unhandledRejection",disableRecording);
  const removeErrorHandlers=()=>{
    process.off("uncaughtException",disableRecording);
    process.off("unhandledRejection",disableRecording);
  };
  const enqueue=(fn:()=>void|Promise<void>)=>{queue=queue.then(()=>{if(recordingEnabled) return fn();}).catch(disableRecording);};
  const snapshot=()=>wire(FrameType.snapshot,{...recording.snapshot(),controller:null,viewers:1});
  const send=(bytes:Buffer)=>{
    if(!viewer || !joined || viewer.destroyed) return;
    if(resync) return;
    if(viewer.writableLength+bytes.length > 1024*1024) {resync=true; return;}
    viewer.write(bytes);
  };
  let proc:Bun.Subprocess;
  try {
    if(typeof Bun.Terminal !== "function") throw Error("PTY unavailable");
    proc=Bun.spawn(["/bin/sh","-c",'input="$1"; shift; exec "$@" < "$input"',"pacer-session",existsSync(join(dir,"stdin"))?join(dir,"stdin"):"/dev/null",...launch.argv],{
      cwd:launch.cwd,env:{...process.env,TERM:"xterm-256color",PWD:launch.cwd},
      terminal:{cols:120,rows:40,name:"xterm-256color",data(_term,data){
        try {
          // Count every redraw, even while masking or line normalization buffers output.
          writeFileSync(join(dir,"session.activity"),"",{mode:0o600});
          if(!recordingEnabled) return;
          const chunk=mask.push(Buffer.from(data));
          if(chunk.length) enqueue(async()=>{await recording.output(chunk);send(wire(FrameType.output,chunk));});
        } catch { disableRecording(); }
      },exit(){terminalClosed();}},
    });
  } catch {
    // Missing PTY support must retain the pipe wrapper's exit/stdout contract.
    removeErrorHandlers();
    await recording.close();
    for(const f of ["session.log","session.log.1","session.ckpt"]) rmSync(join(dir,f),{force:true});
    writeFileSync(join(dir,"session.host"),"none",{mode:0o600});
    const script=join(dir,"run.sh");writeFileSync(script,WRAPPER_SH,{mode:0o700});
    const fallback=Bun.spawn(["/bin/sh",script,dir,...launch.argv],{cwd:launch.cwd,env:process.env,stdin:"ignore",stdout:"ignore",stderr:"ignore"});
    const stop=()=>killTree(fallback.pid,"SIGTERM");
    for(const sig of ["SIGTERM","SIGINT","SIGHUP"] as const) process.on(sig,stop);
    try {return await fallback.exited;} finally {for(const sig of ["SIGTERM","SIGINT","SIGHUP"] as const) process.off(sig,stop);}
  }
  const stop=()=>{stopping=true;killTree(proc.pid,"SIGTERM");};
  for(const sig of ["SIGTERM","SIGINT","SIGHUP"] as const) process.on(sig,stop);
  atomic("child",String(proc.pid));
  try {writeFileSync(join(dir,"session.host"),"builtin",{mode:0o600});} catch { /* optional session metadata */ }
  // xterm supplies fixed DA replies. OSC colours need explicit handlers.
  recording.term.onData(reply=>proc.terminal?.write(reply));
  for(const code of [10,11]) recording.term.parser.registerOscHandler(code,body=>{
    if(body!=="?") return false;
    proc.terminal?.write(`\x1b]${code};rgb:${code===10?"ffff/ffff/ffff":"0000/0000/0000"}\x1b\\`);return true;
  });
  let path:string | undefined;
  try { path=socketPath(dir); } catch { /* unavailable socket directory does not stop the PTY */ }
  const server=createServer(socket=>{
    if(!recordingEnabled) {socket.destroy();return;}
    if(viewer) {socket.end(wire(FrameType.exit,{code:1,reason:"A read-only viewer is already attached"}));return;}
    viewer=socket; joined=false;resync=false;
    const decoder=new WireDecoder();
    socket.on("error",()=>socket.destroy());
    socket.on("drain",()=>enqueue(()=>{if(viewer===socket && joined && resync) {resync=false;socket.write(wire(FrameType.resync,{}));socket.write(snapshot());}}));
    socket.on("data",data=>{
      try {
        for(const frame of decoder.push(Buffer.from(data))) if(frame.type===FrameType.hello && !joined) {
          const hello=JSON.parse(frame.data.toString());if(hello.v!==1) {socket.destroy();return;}
          enqueue(()=>{if(viewer!==socket || joined) return; joined=true;
            const missing=hello.from === undefined ? null : recording.since(hello.from);
            if(missing===null) socket.write(snapshot());
            else for(const bytes of missing) send(wire(FrameType.output,bytes));
            recording.marker("attach",String(hello.label ?? "cli").slice(0,64));});
        }
        // Phase 1 is always read-only: input, size and take are ignored.
      } catch {socket.destroy();}
    });
    socket.on("close",()=>{if(viewer===socket) {viewer=undefined;joined=false;resync=false;enqueue(()=>recording.marker("detach","cli"));}});
  });
  server.on("error",()=>{/* attach is optional; the PTY continues */});
  try {
    if(!path) throw Error("session socket unavailable");
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(path!,()=>{server.off("error",reject);resolve();});});
    chmodSync(path!,0o600);
    if(path && path!==join(dir,"session.sock")) writeFileSync(join(dir,"session.sock.path"),path,{mode:0o600});
  } catch { /* a socket failure must never terminate the attempt */ }
  const code=await proc.exited;
  // Process exit and PTY EOF are separate. Bound the drain if a descendant holds the slave.
  await Promise.race([closed,Bun.sleep(250)]);
  proc.terminal?.close();
  try {
    if(recordingEnabled) {
      const tail=mask.flush(); if(tail.length) enqueue(async()=>{await recording.output(tail);send(wire(FrameType.output,tail));});
    }
  } catch { disableRecording(); }
  await queue;
  try { await recording.close(); } catch { disableRecording(); }
  const result=stopping?143:code;atomic("exit",String(result));
  if(viewer) {
    const socket=viewer;
    await Promise.race([
      new Promise<void>(resolve=>{socket.once("error",()=>resolve());socket.end(wire(FrameType.exit,{code:result}),()=>resolve());}),
      Bun.sleep(250),
    ]);
    socket.destroy();
  }
  server.close();
  if(path) rmSync(path,{force:true});rmSync(join(dir,"session.sock.path"),{force:true});
  for(const sig of ["SIGTERM","SIGINT","SIGHUP"] as const) process.off(sig,stop);
  removeErrorHandlers();
  return result;
}
