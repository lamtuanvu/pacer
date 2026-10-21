import { beginWorkSync, claimWorkSync, attachRunEvidenceSync, finishWorkSync } from "../update/desktop/admission";
import { makeCtx } from "../ctx";
import { readReport, writeReport } from "./reports";
import { createServer, createConnection } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { ViewerHub } from "./viewers";
import { Recording } from "./recording";
import { FrameType, WireDecoder, wire } from "./framing";
import { SecretMasker } from "./masking";
import { killTree } from "../exec/process";
import { WRAPPER_SH } from "../supervisor/wrapper";
import type { InteractionMode } from "../tasks/types";
export interface SessionLaunch { interactionMode?:InteractionMode; completionNonce?:string; takeover?:boolean; interactive?:boolean; argv:string[]; cwd:string; capBytes?:number; pacerHome?:string }
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
/** Internal exec-channel entry point used when sshd disallows streamlocal forwarding. */
export async function pipeSession(path:string):Promise<number> {
  if(!path.startsWith("/") || path.includes("\0")) throw Error("invalid session socket path");
  const socket=createConnection(path);
  try {
    await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
    return await new Promise<number>(resolve=>{
      const stop=()=>socket.destroy();
      socket.on("error",()=>{socket.destroy();});
      socket.once("close",()=>{
        process.stdin.unpipe(socket);process.stdin.pause();
        process.stdin.off("error",stop);process.stdout.off("error",stop);
        resolve(0);
      });
      process.stdin.on("error",stop);process.stdout.on("error",stop);
      process.stdin.pipe(socket);socket.pipe(process.stdout,{end:false});
    });
  } finally {socket.destroy();}
}

/** Detached host entry point. Configuration is prepared by startRun; no strategy reads here. */
export async function sessionHost(dir:string):Promise<number> {
  if(dir.startsWith("socket:"))return pipeSession(dir.slice(7));
  const config = JSON.parse(readFileSync(join(dir,"session.json"),"utf8")) as SessionLaunch;
  const ctx = makeCtx({ pacerHome: config.pacerHome ?? dirname(dirname(dirname(dir))) });
  const inherited = process.env.PACER_ADMISSION_DIR === dir ? process.env.PACER_ADMISSION_SESSION : undefined;
  const lease = inherited ?? beginWorkSync(ctx, { kind: "session", id: createHash("sha256").update(dir).digest("hex"), label: "Executor session" });
  claimWorkSync(ctx, lease);
  attachRunEvidenceSync(ctx, lease, dir);
  // Executor subprocesses must not inherit the private admission capability.
  delete process.env.PACER_ADMISSION_SESSION; delete process.env.PACER_ADMISSION_DIR; delete process.env.PACER_COMPLETION_NONCE;
  const result = await sessionHostAdmitted(dir);
  writeFileSync(join(dir, "admission.complete"), (config.completionNonce ?? lease) + "\n", { mode: 0o600 });
  finishWorkSync(ctx, lease);
  return result;
}
async function sessionHostAdmitted(dir:string):Promise<number> {
  const launch=JSON.parse(readFileSync(join(dir,"session.json"),"utf8")) as SessionLaunch;
  if(launch.cwd.startsWith("~/"))launch.cwd=join(process.env.HOME ?? "",launch.cwd.slice(2));
  const atomic=(name:string,value:string)=>{writeFileSync(join(dir,`${name}.tmp`),value,{mode:0o600});renameSync(join(dir,`${name}.tmp`),join(dir,name));};
  atomic("pid",String(process.pid)); atomic("started",String(Date.now()/1000));
  writeFileSync(join(dir,"stdout"),"",{mode:0o600}); writeFileSync(join(dir,"stderr"),"",{mode:0o600});
  const recording=new Recording(dir,{capBytes:launch.capBytes});
  const mask=new SecretMasker(sessionSecrets(process.env,launch.pacerHome ?? dirname(dirname(dirname(dir)))));
  let queue=Promise.resolve(), stopping=false;
  let hub:ViewerHub | undefined;
  let lastController:string|null=null;
  let terminalClosed!:()=>void;
  const closed=new Promise<void>(resolve=>{terminalClosed=resolve;});
  let recordingEnabled=true;
  const disableRecording=()=>{
    recordingEnabled=false;
    recording.disable();
  };
  process.on("uncaughtException",disableRecording);
  process.on("unhandledRejection",disableRecording);
  const removeErrorHandlers=()=>{
    process.off("uncaughtException",disableRecording);
    process.off("unhandledRejection",disableRecording);
  };
  const enqueue=(fn:()=>void|Promise<void>)=>{queue=queue.then(fn).catch(disableRecording);};
  hub=new ViewerHub(()=>wire(FrameType.snapshot,{...recording.snapshot(),controller:hub!.controller,viewers:hub!.size}),
    from=>recordingEnabled?recording.since(from):null,enqueue,(kind,label)=>{if(recordingEnabled)try{recording.marker(kind,label);}catch{disableRecording();}},(viewers,controller)=>{
      if(controller!==lastController){
        lastController=controller;
        try{writeFileSync(join(dir,'session.activity'),'',{mode:0o600});}catch{/* optional activity */}
      }
      try{atomic('session.state',JSON.stringify({viewers,controller,cols:recording.term.cols,rows:recording.term.rows}));}catch{/* optional live metadata */}
    },{
      release:label=>{if(launch.takeover)writeReport(dir,"done",`Handed back by ${label}`,"user");},
      input:bytes=>{
        if(bytes.length)try{writeFileSync(join(dir,"session.input"),"",{mode:0o600});}catch{/* optional input marker */}
        proc.terminal?.write(bytes);
        try{writeFileSync(join(dir,'session.activity'),'',{mode:0o600});}catch{/* optional activity */}
      },
      resize:(cols,rows)=>{
        proc.terminal?.resize(cols,rows);
        try{recording.resize(cols,rows);}catch{disableRecording();}
        send(wire(FrameType.resize,{cols,rows}));
        try{atomic('session.state',JSON.stringify({viewers:hub!.size,controller:hub!.controller,cols,rows}));}catch{/* optional metadata */}
      },
    });
  try{atomic('session.state',JSON.stringify({viewers:0,controller:null,cols:120,rows:40}));}catch{/* optional live metadata */}
  const send=(bytes:Buffer)=>hub!.broadcast(bytes);
  let proc:Bun.Subprocess;
  try {
    if(typeof Bun.Terminal !== "function") throw Error("PTY unavailable");
    proc=Bun.spawn(launch.interactive ? launch.argv : ["/bin/sh","-c",'input="$1"; shift; exec "$@" < "$input"',"pacer-session",existsSync(join(dir,"stdin"))?join(dir,"stdin"):"/dev/null",...launch.argv],{
      cwd:launch.cwd,env:{...process.env,TERM:"xterm-256color",PWD:launch.cwd},
      terminal:{cols:120,rows:40,name:"xterm-256color",data(_term,data){
        try {
          // Count every redraw, even while masking or line normalization buffers output.
          writeFileSync(join(dir,"session.activity"),"",{mode:0o600});
          if(!recordingEnabled) return;
          const chunk=mask.push(Buffer.from(data));
          if(chunk.length) enqueue(async()=>{if(recordingEnabled)await recording.output(chunk);send(wire(FrameType.output,chunk));});
        } catch { disableRecording(); }
      },exit(){terminalClosed();}},
    });
  } catch (error) {
    if (launch.interactive) {
      removeErrorHandlers();
      await recording.close();
      writeFileSync(join(dir, "stderr"), `pacer: interactive mode requires PTY support: ${String(error)}\n`, {mode: 0o600});
      atomic("session.ended",String(Date.now()/1000));
      atomic("exit", "127");
      return 127;
    }
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
  recording.term.onData(reply=>{if(!hub!.controller)proc.terminal?.write(reply);});
  for(const code of [10,11]) recording.term.parser.registerOscHandler(code,body=>{
    if(body!=="?") return false;
    if(!hub!.controller)proc.terminal?.write(`\x1b]${code};rgb:${code===10?"ffff/ffff/ffff":"0000/0000/0000"}\x1b\\`);return true;
  });
  let path:string | undefined;
  try { path=socketPath(dir); } catch { /* unavailable socket directory does not stop the PTY */ }
  const server=createServer(socket=>{
    hub!.add(socket);
  });
  server.on("error",()=>{/* attach is optional; the PTY continues */});
  try {
    if(!path) throw Error("session socket unavailable");
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(path!,()=>{server.off("error",reject);resolve();});});
    chmodSync(path!,0o600);
    if(path && path!==join(dir,"session.sock")) writeFileSync(join(dir,"session.sock.path"),path,{mode:0o600});
  } catch { /* a socket failure must never terminate the attempt */ }
  // Completion is also consumed here so reporting still ends the TUI if its supervisor died.
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const reports = launch.interactive && launch.interactionMode !== "conversation" ? setInterval(() => {
    const report = readReport(dir);
    if (!stopping && (report?.status === "done" || report?.status === "failed")) {
      stop();
      escalation = setTimeout(() => killTree(proc.pid, "SIGKILL"), 5000);
    }
  }, 100) : undefined;
  let code: number;
  try { code = await proc.exited; atomic("session.ended",String(Date.now()/1000)); }
  finally { if (reports) clearInterval(reports); if (escalation) clearTimeout(escalation); }
  // Process exit and PTY EOF are separate. Bound the drain if a descendant holds the slave.
  await Promise.race([closed,Bun.sleep(250)]);
  proc.terminal?.close();
  try {
    if(recordingEnabled) {
      const tail=mask.flush(); if(tail.length) enqueue(async()=>{await recording.output(tail);send(wire(FrameType.output,tail));});
    }
  } catch { disableRecording(); }
  await queue;
  const result=stopping?143:code;atomic("exit",String(result));
  server.close();
  await Promise.race([hub.end(result),Bun.sleep(250)]);
  hub.destroy();
  try { await recording.close(); } catch { disableRecording(); }
  if(path) rmSync(path,{force:true});rmSync(join(dir,"session.sock.path"),{force:true});
  for(const sig of ["SIGTERM","SIGINT","SIGHUP"] as const) process.off(sig,stop);
  removeErrorHandlers();
  return result;
}
