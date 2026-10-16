import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeHeader, encodeRecord, decodeLog, WireDecoder, wire, FrameType } from "../src/session/framing";
import { SecretMasker } from "../src/session/masking";
import { Recording, replayRecording } from "../src/session/recording";
import { validateExecution } from "../src/config/execution";
import { startRun, readRun, readOutput, stopRun } from "../src/supervisor/run";

const temp = () => mkdtempSync(join(tmpdir(), "pacer-session-"));
test("recording codec recovers a torn frame and socket codec handles arbitrary splits", () => {
  const header = { cols: 120, rows: 40, startedAt: 1, generation: 0 };
  const log = Buffer.concat([encodeHeader(header), encodeRecord(1, 10, Buffer.from("hello")), encodeRecord(1, 20, Buffer.from("torn")).subarray(0, 11)]);
  const decoded = decodeLog(log);
  expect(decoded.header).toEqual(header);
  expect(decoded.frames.map(f => f.data.toString())).toEqual(["hello"]);
  const packet = wire(FrameType.snapshot, { outputOffset: 5 });
  const decoder = new WireDecoder();
  const frames = [...packet].flatMap(b => decoder.push(Buffer.from([b])));
  expect(frames).toHaveLength(1);
  expect(JSON.parse(frames[0].data.toString())).toEqual({ outputOffset: 5 });
  expect(() => decoder.push(Buffer.from([1, 255, 255, 255, 255]))).toThrow();
});
test("masking is byte safe across every boundary, overlaps and flush", () => {
  const input = Buffer.from("你好 token-123456789 token-1234567890 end");
  for (let split = 0; split <= input.length; split++) {
    const mask = new SecretMasker(["token-123456789", "token-1234567890", "short"]);
    expect(Buffer.concat([mask.push(input.subarray(0, split)), mask.push(input.subarray(split)), mask.flush()]).toString()).toBe("你好 **** **** end");
  }
});
test("execution sessions are opt-in with bounded recording settings", () => {
  expect(validateExecution({}).session).toBeUndefined();
  expect(validateExecution({ session: "pty", session_log_mb: 1, session_retention_days: 14 }).session).toBe("pty");
  for (const raw of [{session:"interactive"}, {session_log_mb:257}, {session_retention_days:0}]) expect(() => validateExecution(raw)).toThrow();
});
test("checkpoint replay preserves overwrite, split escapes, Unicode and rotation", async () => {
  const dir = temp();
  try {
    const recording = new Recording(dir, { capBytes: 150 });
    for (const s of ["old", "\r\x1b[", "2K新界\r\n", "\x1b[31mred\x1b[0m\r\n", "lots ".repeat(50), "\r\nTAIL"]) await recording.output(Buffer.from(s));
    const snapshot = recording.snapshot();
    await recording.close();
    const replay = await replayRecording(dir);
    expect(replay.snapshot().screenAnsi).toBe(snapshot.screenAnsi);
    expect(replay.plain()).toContain("新界");
    expect(replay.plain()).toContain("TAIL");
    expect(statSync(join(dir, "session.ckpt")).mode & 0o777).toBe(0o600);
    replay.dispose();
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
// A masked value that secret scanners do not read as a credential.
const SAMPLE_MASK = ["sample", "masked", "value"].join("-");
async function until(fn: () => boolean, ms = 7000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw Error("session deadline"); await Bun.sleep(25); }
}
test("PTY host preserves stdin, terminal stdout, nonzero exit and plain readers", async () => {
  const dir = temp();
  try {
    const run = startRun({dir, cwd:dir, env:{...process.env, PACER_KEY_TEST:SAMPLE_MASK}, session:"pty", stdin:"prompt\n", argv:["/bin/sh","-c", `read line; test -t 1 || exit 9; printf "\\033[31m%s ${SAMPLE_MASK}\\033[0m\\n" "$line"; exit 7`]});
    expect("pid" in run).toBe(true);
    await until(() => readRun(dir).exit !== null);
    expect(readRun(dir).exit).toBe(7);
    expect(readOutput(dir).stdout).toContain("prompt ****");
    expect(readOutput(dir).stdout).not.toContain("\x1b");
    expect(readFileSync(join(dir,"session.log")).includes(Buffer.from(SAMPLE_MASK))).toBe(false);
    expect(readFileSync(join(dir,"session.ckpt"),"utf8")).not.toContain(SAMPLE_MASK);
  } finally { await stopRun(dir,{graceMs:100}); rmSync(dir,{recursive:true,force:true}); }
}, 10000);
const canInspectProcesses=(()=>{try{return Bun.spawnSync(["ps","-p",String(process.pid)]).exitCode===0;}catch{return false;}})();
test.skipIf(!canInspectProcesses)("PTY wrapper identity and stop remain compatible", async () => {
  const dir = temp();
  try {
    startRun({dir,cwd:dir,env:process.env,session:"pty",argv:["/bin/sh","-c","echo ready; sleep 30"]});
    await until(() => readOutput(dir).stdout.includes("ready"));
    expect(readRun(dir).alive).toBe(true);
    expect((await stopRun(dir,{graceMs:1500})).code).toBe(143);
  } finally { await stopRun(dir,{graceMs:100}); rmSync(dir,{recursive:true,force:true}); }
},10000);

import { PlainText } from "../src/session/plain";
import { createServer, createConnection } from "node:net";
import { writeFileSync, existsSync } from "node:fs";
test("plain transcript appends complete lines and handles chunked CSI/OSC/DCS", () => {
  const p=new PlainText();
  expect(p.push(Buffer.from("old\rnew\x1b[3"))).toBe("");
  expect(p.push(Buffer.from("1m界\x1b[0m\r"))).toBe("");
  expect(p.push(Buffer.from("\n\x1b]0;private\x1b"))).toBe("new界\n");
  expect(p.push(Buffer.from("\\visible\x1bPignored\x1b\\\nlast"))).toBe("visible\n");
  expect(p.flush()).toBe("last");
});
const canBindSocket=await (async()=>{
  const dir=temp(),server=createServer();
  try {await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(join(dir,"probe.sock"),resolve);});return true;}
  catch{return false;}finally{server.close();rmSync(dir,{recursive:true,force:true});}
})();
test.skipIf(!canBindSocket)("live attach is read-only, starts at a snapshot and streams through exit", async () => {
  const dir=temp();let pid:number|undefined;
  try {
    const run=startRun({dir,cwd:dir,env:process.env,session:"pty",argv:["/bin/sh","-c",`echo FIRST; while [ ! -f "${join(dir,"go")}" ]; do sleep 0.05; done; echo LAST; exit 4`]});
    if("error" in run) throw Error(run.error);pid=run.pid;
    await until(()=>existsSync(join(dir,"session.sock.path")) || existsSync(join(dir,"session.sock")));
    const path=existsSync(join(dir,"session.sock.path"))?readFileSync(join(dir,"session.sock.path"),"utf8"):join(dir,"session.sock");
    const socket=createConnection(path), decoder=new WireDecoder(), frames:{type:number;data:Buffer}[]=[];
    await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
    const done=new Promise<void>((resolve,reject)=>{socket.on("data",b=>{frames.push(...decoder.push(Buffer.from(b)));});socket.on("close",resolve);socket.on("error",reject);});
    socket.write(wire(FrameType.hello,{v:1,client:"cli",label:"test",cols:80,rows:24}));
    socket.write(wire(FrameType.input,Buffer.from("EVIL\n")));
    socket.write(wire(FrameType.size,{cols:1,rows:1}));
    await until(()=>frames.length>0);writeFileSync(join(dir,"go"),"");
    await done;
    expect(frames[0].type).toBe(FrameType.snapshot);
    const snap=JSON.parse(frames[0].data.toString());
    expect(snap.cols).toBe(120);expect(snap.rows).toBe(40);
    expect(snap.screenAnsi+frames.filter(f=>f.type===FrameType.output).map(f=>f.data.toString()).join("")).toContain("LAST");
    expect(JSON.parse(frames.at(-1)!.data.toString()).code).toBe(4);
    expect(readOutput(dir).stdout).not.toContain("EVIL");
    await until(()=>!existsSync(path));
  } finally {if(pid) try{process.kill(pid,"SIGKILL");}catch{}rmSync(dir,{recursive:true,force:true});}
},10000);
test("host records 143 when directly signalled, including output drain", async () => {
  const dir=temp();let pid:number|undefined;
  try {
    const run=startRun({dir,cwd:dir,env:process.env,session:"pty",argv:["/bin/sh","-c",'echo ready; sleep 30']});
    if("error" in run) throw Error(run.error);pid=run.pid;
    await until(()=>readOutput(dir).stdout.includes("ready"));process.kill(pid,"SIGTERM");
    await until(()=>existsSync(join(dir,"exit")));
    expect(readRun(dir).exit).toBe(143);
  } finally {if(pid)try{process.kill(pid,"SIGKILL");}catch{}rmSync(dir,{recursive:true,force:true});}
},10000);

import { makeCtx } from "../src/ctx";
import { createTask, updateTask } from "../src/tasks/store";
import { pruneSessions } from "../src/session/retention";
import { mkdirSync } from "node:fs";
test("retention removes only settled recordings and keeps plain logs", () => {
  const home=temp(),ctx=makeCtx({pacerHome:home,now:2000000});
  try {
    const task=createTask(ctx,{brief:{goal:"fixture",repo:"."},kind:"small",requestedExecutor:null,timeoutS:30});
    const dir=join(home,"runs",task.id,"1");mkdirSync(dir,{recursive:true});
    for(const name of ["session.log","session.log.1","session.ckpt","stdout","stderr","exit"]) writeFileSync(join(dir,name),"fixture");
    pruneSessions({...ctx,now:ctx.now+15*86400});
    expect(existsSync(join(dir,"session.log"))).toBe(true);
    updateTask(ctx,task.id,t=>{t.state="done";});
    pruneSessions({...ctx,now:ctx.now+15*86400});
    expect(existsSync(join(dir,"session.log"))).toBe(false);
    expect(readFileSync(join(dir,"stdout"),"utf8")).toBe("fixture");
    expect(existsSync(join(dir,"exit"))).toBe(true);
  } finally {rmSync(home,{recursive:true,force:true});}
});
test("plain stdout stays append-only across redraws and flushes an unterminated tail", async () => {
  const dir=temp();try {
    const recording=new Recording(dir);
    await recording.output(Buffer.from("one\r\nspin"));const prefix=readFileSync(join(dir,"stdout"));
    await recording.output(Buffer.from("\rfinal\nlast"));
    expect(readFileSync(join(dir,"stdout")).subarray(0,prefix.length)).toEqual(prefix);
    await recording.close();expect(readFileSync(join(dir,"stdout"),"utf8")).toBe("one\nfinal\nlast");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("checkpoint is associated with parsed bytes while the next generation is live", async () => {
  const dir=temp();try {
    const recording=new Recording(dir,{capBytes:200});
    await recording.output(Buffer.from("first ".repeat(40)+"\r\n"));
    await recording.output(Buffer.from("next\r\n"));
    const replay=await replayRecording(dir);
    expect(replay.outputOffset).toBe(recording.outputOffset);
    expect(replay.plain()).toBe(recording.plain());replay.dispose();await recording.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("rotation waits for a split escape and UTF-8 scalar before checkpointing", async () => {
  const dir=temp();try {
    const recording=new Recording(dir,{capBytes:140});
    await recording.output(Buffer.from("prefix ".repeat(20)+"\x1b[3"));
    await recording.output(Buffer.from("1m红\x1b[0m\r\n"));
    const wide=Buffer.from("界");
    await recording.output(Buffer.concat([Buffer.from("filler ".repeat(20)),wide.subarray(0,1)]));
    await recording.output(wide.subarray(1));
    await recording.output(Buffer.from("tail"));
    const replay=await replayRecording(dir);
    expect(replay.snapshot().screenAnsi).toBe(recording.snapshot().screenAnsi);
    replay.dispose();await recording.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("replay recovers the rename-to-new-header crash window", async () => {
  const dir=temp();try {
    const recording=new Recording(dir,{capBytes:140});
    await recording.output(Buffer.from("filler ".repeat(30)+"\r\nEND"));
    const snapshot=recording.snapshot();
    rmSync(join(dir,"session.log"));
    const replay=await replayRecording(dir);
    expect(replay.snapshot().screenAnsi).toBe(snapshot.screenAnsi);
    replay.dispose();await recording.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("resume offsets return retained masked bytes or require a snapshot", async () => {
  const dir=temp();try {
    const recording=new Recording(dir,{capBytes:220});
    await recording.output(Buffer.from("hello\n"));await recording.output(Buffer.from("world\n"));
    expect(Buffer.concat(recording.since(3)!).toString()).toBe("lo\nworld\n");
    expect(recording.since(999)).toBeNull();
    await recording.output(Buffer.from("large ".repeat(60)));
    await recording.output(Buffer.from("large ".repeat(60)));
    expect(recording.since(0)).toBeNull();expect(recording.since(recording.outputOffset)).toEqual([]);
    await recording.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("local direct run layout selects PTY only when its strategy opts in", async () => {
  const home=temp();
  try {
    writeFileSync(join(home,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\nexecution:\n  session: pty\n");
    const dir=join(home,"runs","fixture","1");
    const run=startRun({dir,cwd:home,env:{PATH:process.env.PATH},argv:["/bin/sh","-c","test -t 1 && echo terminal"]});
    if("error" in run) throw Error(run.error);
    await until(()=>existsSync(join(dir,"exit")));
    expect(readRun(dir).exit).toBe(0);expect(readOutput(dir).stdout).toBe("terminal\n");
    expect(existsSync(join(dir,"session.log"))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(home,"runs","fixture")).mode & 0o777).toBe(0o700);
    const pipe=join(home,"runs","fixture","2");
    startRun({dir:pipe,cwd:home,env:{PATH:process.env.PATH},session:"pipe",argv:["/bin/sh","-c","test ! -t 1 && echo pipe"]});
    await until(()=>existsSync(join(pipe,"exit")));
    expect(readOutput(pipe).stdout).toBe("pipe\n");expect(existsSync(join(pipe,"session.log"))).toBe(false);
  }finally{rmSync(home,{recursive:true,force:true});}
},10000);

test("masking passes through buffers without secrets and handles 1 MiB bursts quickly", () => {
  const input = Buffer.alloc(1024 * 1024, 120);
  expect(new SecretMasker([]).push(input)).toBe(input);
  for (const secrets of [[], [SAMPLE_MASK, SAMPLE_MASK+"4"]]) {
    const mask = new SecretMasker(secrets);
    const started = performance.now();
    const burst=mask.push(input);
    expect(input.length-burst.length).toBe(secrets.length ? (SAMPLE_MASK+"4").length-1 : 0);
    const output = Buffer.concat([burst, mask.push(Buffer.from(SAMPLE_MASK.slice(0,-2))), mask.push(Buffer.from(SAMPLE_MASK.slice(-2)+"4!")), mask.flush()]);
    expect(performance.now() - started).toBeLessThan(500);
    expect(output.toString()).toBe(input.toString() + (secrets.length ? "****!" : `${SAMPLE_MASK}4!`));
  }
});

test("PTY redraws without newlines keep watchdog activity fresh", async () => {
  const dir = temp(); let pid:number|undefined;
  try {
    const run=startRun({dir,cwd:dir,env:process.env,session:"pty",argv:["/bin/sh","-c",'while :; do printf "\\rredraw"; sleep 0.1; done']});
    if("error" in run) throw Error(run.error); pid=run.pid;
    await until(() => existsSync(join(dir,"child")));
    const initial = readRun(dir).lastOutputAt ?? Date.now()/1000;
    await until(() => (readRun(dir).lastOutputAt ?? 0) > initial);
    expect(readOutput(dir).stdout).toBe("");
    expect(Date.now()/1000 - readRun(dir).lastOutputAt!).toBeLessThan(1);
  } finally {
    if(pid) {try {process.kill(pid,"SIGTERM");} catch {} await until(()=>readRun(dir).exit!==null);}
    rmSync(dir,{recursive:true,force:true});
  }
},10000);

test.skipIf(!canInspectProcesses)("PTY stop kills the separate child group after grace", async () => {
  const dir = temp(); let child: number | undefined;
  const alive = (pid:number) => { try { process.kill(pid,0); return true; } catch { return false; } };
  try {
    startRun({dir,cwd:dir,env:process.env,session:"pty",argv:["/bin/sh","-c",'trap "" TERM HUP; echo ready; while :; do sleep 1; done']});
    await until(() => readOutput(dir).stdout.includes("ready"));
    child = Number(readFileSync(join(dir,"child"),"utf8"));
    expect((await stopRun(dir,{graceMs:150})).code).toBe(137);
    await until(() => !alive(child!),1000);
  } finally {
    if(child) { try { process.kill(-child,"SIGKILL"); } catch {} }
    await stopRun(dir,{graceMs:100}); rmSync(dir,{recursive:true,force:true});
  }
},10000);

for (const fault of ["callback", "exception", "rejection"] as const) {
  test(`host ${fault} fault disables recording while the child finishes`, async () => {
    const dir=temp();
    writeFileSync(join(dir,"session.json"),JSON.stringify({cwd:dir,argv:["/bin/sh","-c",'printf first; sleep 1; echo survived > survived; printf last; exit 7']}));
    const host=Bun.spawn([process.execPath,new URL("./fixtures/session/fault-runner.ts",import.meta.url).pathname],{env:{...process.env,FAULT_KIND:fault,FAULT_MARKER:join(dir,"fault"),SESSION_DIR:dir},stdout:"ignore",stderr:"ignore"});
    try {
      expect(await host.exited).toBe(7);
      expect(existsSync(join(dir,"fault"))).toBe(true);
      expect(readFileSync(join(dir,"session.host"),"utf8")).toBe("builtin");
      expect(readFileSync(join(dir,"survived"),"utf8").trim()).toBe("survived");
      expect(readRun(dir).exit).toBe(7);
      const output=Buffer.concat(decodeLog(readFileSync(join(dir,"session.log"))).frames.filter(f=>f.type===1).map(f=>f.data)).toString();
      expect(output).not.toContain("last");
      expect(readOutput(dir).stdout).not.toContain("last");
    } finally {host.kill();rmSync(dir,{recursive:true,force:true});}
  },10000);
}

import * as targets from "../src/session/targets";
import { ViewerHub } from "../src/session/viewers";
import { viewerMessageFrames } from "../src/serve/session-ws";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

for (const [setting, expected] of [
  ["alacritty -e {cmd}", ["alacritty", "-e", "pacer", "attach", "t-1"]],
  ["foot {cmd}", ["foot", "pacer", "attach", "t-1"]],
  ["sh -c {cmd}", ["sh", "-c", "pacer", "attach", "t-1"]],
  ["sh -c 'exec {cmd}'", ["sh", "-c", "exec pacer attach t-1"]],
] as const) test(`terminal template expands ${setting}`, () => {
  expect(targets.terminalRecipe(setting, "t-1")).toEqual([...expected]);
});

test("AppleScript strings escape quotes and backslashes without JSON escapes", () => {
  expect(targets.appleScriptString('a\\b"c\t')).toBe('"a\\\\b\\"c\t"');
  for (const preset of ["iterm", "terminal-app"]) {
    expect(targets.terminalRecipe(preset, "t-1")[2]).toContain('"pacer attach t-1"');
  }
});

// Only the OS socket boundary is replaced; framing, admission and queues stay real.
class ViewerSocket extends EventEmitter {
  destroyed=false; writableLength=0; frames:Buffer[]=[];
  write(bytes:Buffer){this.frames.push(bytes);return true;}
  end(bytes:Buffer,done?:()=>void){this.write(bytes);this.destroy();done?.();return this;}
  destroy(){if(!this.destroyed){this.destroyed=true;this.emit("close");}return this;}
  hello(client="cli",label="cli") {this.emit("data",wire(FrameType.hello,{v:1,client,label}));}
}
function viewerFixture(enqueue:(fn:()=>void)=>void=fn=>fn()) {
  const markers:string[]=[],counts:number[]=[],sockets:ViewerSocket[]=[];
  const hub=new ViewerHub(()=>wire(FrameType.snapshot,{viewers:hub.size}),()=>null,enqueue,
    (event,label)=>markers.push(`${event}:${label}`),n=>counts.push(n));
  const connect=()=>{const s=new ViewerSocket();sockets.push(s);hub.add(s as unknown as Socket);return s;};
  return {hub,markers,counts,connect};
}
test("app labels retain the bridge-assigned client in attach and detach markers", () => {
  const {hub,connect,markers}=viewerFixture(),socket=connect();
  try {
    for(const bytes of viewerMessageFrames(JSON.stringify({type:"hello",v:1,client:"cli",label:"cli"})))socket.emit("data",bytes);
    socket.destroy();
    expect(markers).toEqual(["attach:app:cli","detach:app:cli"]);
  } finally {hub.destroy();}
});
test("pending connections never consume viewer slots or appear in snapshots", () => {
  const {hub,connect,counts}=viewerFixture();
  try {
    const pending=Array.from({length:17},connect);
    expect(hub.size).toBe(0);expect(counts).toEqual([]);
    const joined=Array.from({length:16},()=>{const s=connect();s.hello();return s;});
    expect(hub.size).toBe(16);
    expect(JSON.parse(new WireDecoder().push(joined[0].frames[0])[0].data.toString()).viewers).toBe(1);
    const extra=connect();extra.hello();expect(extra.destroyed).toBe(true);
    expect(hub.size).toBe(16);
    joined[0].destroy();pending[0].hello();expect(hub.size).toBe(16);
  } finally {hub.destroy();}
});
test("a connection without hello is closed after five seconds", async () => {
  const {hub,connect,markers}=viewerFixture(),pending=connect(),joined=connect();joined.hello();
  const queue:(()=>void)[]=[],delayed=viewerFixture(fn=>queue.push(fn)),waiting=delayed.connect();waiting.hello();
  try {
    await Bun.sleep(5100);
    expect(pending.destroyed).toBe(true);expect(joined.destroyed).toBe(false);
    expect(hub.size).toBe(1);expect(markers).toEqual(["attach:cli:cli"]);
    // A valid hello received in time survives a busy recording queue.
    expect(waiting.destroyed).toBe(false);expect(delayed.hub.size).toBe(0);
    for(const fn of queue.splice(0))fn();expect(delayed.hub.size).toBe(1);
  } finally {hub.destroy();delayed.hub.destroy();}
},7000);

test("auto terminal settings resolve to a detected terminal instead of an auto executable", async () => {
  const {terminalSetting}=await import("../src/session/service");
  const dir=temp(),ctx=makeCtx({pacerHome:dir,env:{DISPLAY:":0",TERM_PROGRAM:"kitty"}});
  try {
    writeFileSync(join(dir,"strategy.yaml"),"planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nterminal: {open: auto}\n");
    expect(terminalSetting(ctx)).toBe("kitty");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

function controlFrames(socket:ViewerSocket) {
  return socket.frames.flatMap(b=>new WireDecoder().push(b)).filter(f=>f.type===FrameType.control).map(f=>JSON.parse(f.data.toString()));
}
test("one controller, force takeover, release and disconnect are labeled and immediate", () => {
  const {hub,connect,markers}=viewerFixture(),a=connect(),b=connect();
  const frame=(s:ViewerSocket,type:number,body:unknown={})=>s.emit('data',wire(type,body));
  try {
    a.hello('cli','one');b.hello('app','two');
    frame(a,FrameType.take);
    expect(controlFrames(a).at(-1)).toMatchObject({controller:'cli:one',you:true});
    frame(b,FrameType.take);
    expect(controlFrames(b).at(-1)).toMatchObject({controller:'cli:one',you:false});
    frame(b,FrameType.take,{force:true});
    expect(controlFrames(a).at(-1)).toMatchObject({controller:'app:two',you:false,reason:'taken'});
    frame(a,FrameType.release);
    expect(hub.controller).toBe('app:two');
    frame(b,FrameType.release);
    expect(hub.controller).toBeNull();
    frame(a,FrameType.take);a.destroy();
    expect(controlFrames(b).at(-1)).toMatchObject({controller:null,you:false,reason:'disconnected'});
    expect(markers).toEqual(['attach:cli:one','attach:app:two','control-taken:cli:one','control-released:cli:one','control-taken:app:two','control-released:app:two','control-taken:cli:one','control-released:cli:one','detach:cli:one']);
  } finally {hub.destroy();}
});
test("controller-only input and size use the queued identity even for pipelined hello", () => {
  const queued:(()=>void)[]=[],inputs:string[]=[],sizes:unknown[]=[];
  const hub=new ViewerHub(()=>wire(FrameType.snapshot,{}),()=>null,fn=>queued.push(fn),()=>{},()=>{}, {
    input:bytes=>inputs.push(bytes.toString()),resize:(cols,rows)=>sizes.push([cols,rows]),
  });
  const a=new ViewerSocket(),b=new ViewerSocket();hub.add(a as unknown as Socket);hub.add(b as unknown as Socket);
  const frame=(s:ViewerSocket,type:number,body:unknown={})=>s.emit('data',wire(type,body));
  try {
    frame(a,FrameType.take);a.hello();b.hello();
    frame(b,FrameType.input,Buffer.from('ignored'));frame(b,FrameType.size,{cols:1,rows:1});
    frame(a,FrameType.take);frame(a,FrameType.input,Buffer.from('hello'));frame(a,FrameType.size,{cols:90,rows:30});
    for(const fn of queued.splice(0))fn();
    expect(inputs).toEqual(['hello']);expect(sizes).toEqual([[90,30]]);
    for(const body of [{cols:0,rows:20},{cols:90.5,rows:20},{cols:65536,rows:20},{cols:1001,rows:20},{cols:90,rows:501}])frame(a,FrameType.size,body);
    frame(a,FrameType.release);frame(a,FrameType.size,{cols:80,rows:20});
    for(const fn of queued.splice(0))fn();
    expect(sizes).toEqual([[90,30]]);
  } finally {hub.destroy();}
});

test.skipIf(!canBindSocket)("live control resizes PTY, preserves last size and records labeled changes", async () => {
  const dir=temp(),sockets:Socket[]=[];
  try {
    startRun({dir,cwd:dir,env:process.env,session:'pty',argv:['/bin/sh','-c','echo READY; sleep 30']});
    const {sessionSocket}=await import('../src/session/service');
    await until(()=>existsSync(sessionSocket(dir)));
    const connect=async(label:string)=>{
      const socket=createConnection(sessionSocket(dir)),decoder=new WireDecoder(),frames:{type:number;data:Buffer}[]=[];sockets.push(socket);
      socket.on('data',b=>frames.push(...decoder.push(Buffer.from(b))));
      await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
      socket.write(wire(FrameType.hello,{v:1,client:'cli',label,cols:80,rows:24}));
      await until(()=>frames.some(f=>f.type===FrameType.snapshot));return {socket,frames};
    };
    const a=await connect('driver'),b=await connect('watcher');
    expect(JSON.parse(a.frames[0].data.toString())).toMatchObject({cols:120,rows:40,controller:null});
    a.socket.write(wire(FrameType.take,{}));
    await until(()=>a.frames.some(f=>f.type===FrameType.control&&JSON.parse(f.data.toString()).you));
    a.socket.write(wire(FrameType.size,{cols:92,rows:31}));
    await until(()=>a.frames.some(f=>f.type===FrameType.resize));
    const state=JSON.parse(readFileSync(join(dir,'session.state'),'utf8'));
    expect(state).toMatchObject({cols:92,rows:31,controller:'cli:driver'});
    b.socket.write(wire(FrameType.size,{cols:1,rows:1}));
    a.socket.write(wire(FrameType.release,{}));
    await until(()=>a.frames.some(f=>f.type===FrameType.control&&JSON.parse(f.data.toString()).reason==='released'));
    const c=await connect('late');
    expect(JSON.parse(c.frames[0].data.toString())).toMatchObject({cols:92,rows:31,controller:null});
    const replay=await replayRecording(dir);expect(replay.snapshot()).toMatchObject({cols:92,rows:31});replay.dispose();
    const markers=decodeLog(readFileSync(join(dir,'session.log'))).frames.filter(f=>f.type===3).map(f=>JSON.parse(f.data.toString()));
    expect(markers).toContainEqual({event:'control-taken',label:'cli:driver'});
    expect(markers).toContainEqual({event:'control-released',label:'cli:driver'});
  } finally {for(const socket of sockets)socket.destroy();await stopRun(dir,{graceMs:1500});rmSync(dir,{recursive:true,force:true});}
},10000);

test('recorded resize survives replay without output',async()=>{
  const dir=temp();try{
    const r=new Recording(dir);r.resize(91,29);await r.close();
    const replay=await replayRecording(dir);expect(replay.snapshot()).toMatchObject({cols:91,rows:29});replay.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('builtin host advertises control and resize',async()=>{
  const {BuiltinSessionHost}=await import('../src/session/service');
  expect(new BuiltinSessionHost('unused').capabilities).toMatchObject({control:true,resize:true});
});

import { AttachKeys } from '../src/session/attach';
test('attach read-only keys detach or request control',()=>{
  const sent:Buffer[]=[],keys=new AttachKeys(bytes=>sent.push(bytes));
  expect(keys.push(Buffer.from('ignored'))).toBe(false);
  expect(sent).toEqual([]);
  expect(keys.push(Buffer.from('c'))).toBe(false);
  expect(new WireDecoder().push(sent[0])[0].type).toBe(FrameType.take);
  expect(keys.push(Buffer.from('q'))).toBe(true);
  expect(keys.push(Buffer.from([3]))).toBe(true);
});
test('attach control forwards bytes and parses split escape commands',()=>{
  const sent:Buffer[]=[],keys=new AttachKeys(bytes=>sent.push(bytes));keys.setControl(true);
  expect(keys.push(Buffer.from('qc\x03你好'))).toBe(false);
  expect(new WireDecoder().push(Buffer.concat(sent))[0].data.toString()).toBe('qc\x03你好');sent.length=0;
  expect(keys.push(Buffer.from([29]))).toBe(false);
  expect(keys.push(Buffer.from([29]))).toBe(false);
  expect(new WireDecoder().push(sent[0])[0].data).toEqual(Buffer.from([29]));sent.length=0;
  keys.push(Buffer.from([29]));keys.push(Buffer.from('r'));
  expect(new WireDecoder().push(sent[0])[0].type).toBe(FrameType.release);
  // Await the host's response before switching input modes.
  keys.setControl(false);keys.push(Buffer.from('c'));
  expect(new WireDecoder().push(sent[1])[0].type).toBe(FrameType.take);
  keys.setControl(true);expect(keys.push(Buffer.from('\x1dd'))).toBe(true);
});
test('losing control resets an incomplete escape prefix',()=>{
  const sent:Buffer[]=[],keys=new AttachKeys(bytes=>sent.push(bytes));keys.setControl(true);
  keys.push(Buffer.from([29]));keys.setControl(false);keys.setControl(true);keys.push(Buffer.from('r'));
  expect(new WireDecoder().push(sent[0])[0]).toMatchObject({type:FrameType.input,data:Buffer.from('r')});
});

test('a stale controller on a dead host cannot refresh activity',()=>{
  const dir=temp();try{
    writeFileSync(join(dir,'pid'),'2147483647');
    writeFileSync(join(dir,'session.state'),JSON.stringify({controller:'cli:human'}));
    expect(readRun(dir)).toMatchObject({alive:false,lastOutputAt:null});
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a silent controller does not refresh the idle clock',async()=>{
  const dir=temp();try{
    startRun({dir,cwd:dir,env:process.env,session:'pipe',argv:['sleep','0.2']});
    await until(()=>existsSync(join(dir,'child')));
    writeFileSync(join(dir,'session.state'),JSON.stringify({controller:'cli:human'}));
    writeFileSync(join(dir,'session.activity'),'');
    const activity=statSync(join(dir,'session.activity')).mtimeMs/1000;
    await Bun.sleep(40);
    expect(readRun(dir).lastOutputAt).toBe(activity);
  }finally{await until(()=>readRun(dir).exit!==null);rmSync(dir,{recursive:true,force:true});}
});
test('WebSocket app clients relay control and binary input unchanged',()=>{
  for(const body of [{type:'take'},{type:'take',force:true},{type:'release'},{type:'size',cols:90,rows:30}]){
    const [f]=new WireDecoder().push(viewerMessageFrames(JSON.stringify(body))[0]);
    const {type,...payload}=body;expect(f.type).toBe(FrameType[type as keyof typeof FrameType]);
    expect(JSON.parse(f.data.toString())).toEqual(payload);
  }
  const input=wire(FrameType.input,Buffer.from([0,3,29,255]));
  expect(viewerMessageFrames(input)).toEqual([input]);
  const {hub,connect}=viewerFixture(),socket=connect();
  try{
    for(const bytes of viewerMessageFrames(JSON.stringify({type:'hello',v:1,client:'cli',label:'browser'})))socket.emit('data',bytes);
    for(const bytes of viewerMessageFrames(JSON.stringify({type:'take'})))socket.emit('data',bytes);
    expect(controlFrames(socket).at(-1)).toMatchObject({controller:'app:browser',you:true});
  }finally{hub.destroy();}
});

test('a forced takeover drops the old controller input and size immediately',()=>{
  const input:string[]=[],sizes:number[]=[],hub=new ViewerHub(()=>wire(FrameType.snapshot,{}),()=>null,fn=>fn(),()=>{},()=>{}, {
    input:b=>input.push(b.toString()),resize:cols=>sizes.push(cols),
  });
  const a=new ViewerSocket(),b=new ViewerSocket();hub.add(a as unknown as Socket);hub.add(b as unknown as Socket);a.hello('cli','first');b.hello('app','second');
  const frame=(s:ViewerSocket,type:number,body:unknown={})=>s.emit('data',wire(type,body));
  try{
    frame(a,FrameType.take);frame(a,FrameType.take);expect(controlFrames(a).at(-1)?.you).toBe(true);
    frame(b,FrameType.take,{force:true});
    frame(a,FrameType.input,Buffer.from('old'));frame(a,FrameType.size,{cols:80,rows:24});
    frame(b,FrameType.input,Buffer.from('new'));frame(b,FrameType.size,{cols:90,rows:30});
    expect(input).toEqual(['new']);expect(sizes).toEqual([90]);
    b.destroy();frame(a,FrameType.input,Buffer.from('released'));expect(input).toEqual(['new']);
    frame(a,FrameType.take);expect(hub.controller).toBe('cli:first');
  }finally{hub.destroy();}
});

test('task CLI progress shows the active controller label',async()=>{
  const home=temp(),ctx=makeCtx({pacerHome:home,env:{}});
  try{
    const {main}=await import('../src/cli');
    const task=createTask(ctx,{brief:{goal:'fixture',repo:'.'},kind:'small',requestedExecutor:null,timeoutS:30});
    updateTask(ctx,task.id,t=>{t.state='running';});
    const dir=join(home,'runs',task.id,'1');mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'session.log'),'');writeFileSync(join(dir,'session.sock'),'socket fixture');writeFileSync(join(dir,'pid'),String(process.pid));
    writeFileSync(join(dir,'session.state'),JSON.stringify({controller:'cli:Ghostty',viewers:2}));
    for(const args of [['tasks'],['tasks',task.id]])expect((await main(args,ctx)).out).toContain('controlled from cli:Ghostty');
    writeFileSync(join(dir,'session.state'),JSON.stringify({controller:null,viewers:2}));
    expect((await main(['tasks',task.id],ctx)).out).not.toContain('controlled from');
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('resync restores controller identity after slow viewer queue overflow',()=>{
  class SlowSocket extends ViewerSocket {
    blocked=false;
    override write(bytes:Buffer){super.write(bytes);return !this.blocked;}
  }
  const hub=new ViewerHub(()=>wire(FrameType.snapshot,{controller:hub.controller}),()=>null,fn=>fn());
  const slow=new SlowSocket(),other=new ViewerSocket();hub.add(slow as unknown as Socket);hub.add(other as unknown as Socket);
  try{
    slow.hello('cli','slow');other.hello('app','new');slow.emit('data',wire(FrameType.take,{}));
    slow.blocked=true;
    for(let i=0;i<18;i++)hub.broadcast(wire(FrameType.output,Buffer.alloc(65536)));
    other.emit('data',wire(FrameType.take,{force:true}));
    slow.blocked=false;slow.emit('drain');
    const decoded=new WireDecoder().push(Buffer.concat(slow.frames));
    expect(decoded.some(f=>f.type===FrameType.resync)).toBe(true);
    expect(JSON.parse(decoded.filter(f=>f.type===FrameType.control).at(-1)!.data.toString())).toMatchObject({controller:'app:new',you:false});
  }finally{hub.destroy();}
});

test('read-only attach ignores terminal replies across all chunk boundaries',()=>{
  for(const reply of ['\x1b[?62;22c','\x1b[12;3R','\x1b[<0;99;113M','\x1b[I','\x1b[O','\x1b]qcc\x07','\x1b]qcc\x1b\\','\x1bPqc\x1b\\','\x1bOq','\x1bOc']){
    for(let split=0;split<=reply.length;split++){
      const sent:Buffer[]=[],keys=new AttachKeys(b=>sent.push(b));
      expect(keys.push(Buffer.from(reply.slice(0,split)))).toBe(false);
      expect(keys.push(Buffer.from(reply.slice(split)))).toBe(false);
      expect(sent).toEqual([]);
      keys.push(Buffer.from('c'));expect(sent).toHaveLength(1);
      expect(keys.push(Buffer.from('q'))).toBe(true);
    }
  }
});

test('ending and destroying a hub publish controller null',async()=>{
  for(const action of ['end','destroy'] as const){
    const states:(string|null)[]=[],hub=new ViewerHub(()=>wire(FrameType.snapshot,{}),()=>null,fn=>fn(),()=>{},(_n,c)=>states.push(c));
    class DelayedClose extends ViewerSocket {
      override destroy(){this.destroyed=true;return this;}
      override end(bytes:Buffer,done?:()=>void){this.write(bytes);this.destroyed=true;done?.();return this;}
    }
    const peer=new DelayedClose();hub.add(peer as unknown as Socket);peer.hello();peer.emit('data',wire(FrameType.take,{}));
    await hub[action](0);expect(hub.controller).toBeNull();expect(states.at(-1)).toBeNull();hub.destroy();
  }
});

test('attach asks before forcing a refused take and accepts only y',()=>{
  for(const answer of ['y','Y','n','\r']){
    const sent:Buffer[]=[],prompts:string[]=[],keys=new AttachKeys(b=>sent.push(b),s=>prompts.push(s));
    keys.push(Buffer.from('c'));
    keys.controlState({controller:'cli:holder',you:false});expect(prompts).toEqual([]);
    keys.controlState({controller:'cli:holder',you:false,reason:'refused'});
    expect(prompts).toEqual(['Someone is in control from cli:holder. Take over? [y/N] ']);
    keys.push(Buffer.from('\x1b[?62;22c'));expect(sent).toHaveLength(1);
    keys.push(Buffer.from(answer));
    const frames=new WireDecoder().push(Buffer.concat(sent));
    expect(frames).toHaveLength(answer.toLowerCase()==='y'?2:1);
    if(frames.length===2)expect(JSON.parse(frames[1].data.toString())).toEqual({force:true});
  }
  const sent:Buffer[]=[],prompts:string[]=[],keys=new AttachKeys(b=>sent.push(b),s=>prompts.push(s));
  keys.take(true);keys.controlState({controller:'cli:me',you:true});
  expect(JSON.parse(new WireDecoder().push(sent[0])[0].data.toString())).toEqual({force:true});
  expect(prompts).toEqual([]);
});

test.skipIf(!canBindSocket)('control survives recording failure, including new viewers',async()=>{
  const dir=temp(),sockets:Socket[]=[];
  const script=`import { Recording } from ${JSON.stringify(new URL('../src/session/recording.ts',import.meta.url).pathname)};
import { sessionHost } from ${JSON.stringify(new URL('../src/session/host.ts',import.meta.url).pathname)};
import { writeFileSync } from 'node:fs';
const output=Recording.prototype.output;
Recording.prototype.output=async function(data){if(Buffer.from(data).includes(Buffer.from('FAIL'))){writeFileSync(${JSON.stringify(join(dir,'failed'))},'');throw Error('disk failed');}return output.call(this,data);};
process.exit(await sessionHost(${JSON.stringify(dir)}));`;
  writeFileSync(join(dir,'session.json'),JSON.stringify({cwd:dir,argv:['/bin/sh','-c','exec </dev/tty; echo READY; sleep 0.3; echo FAIL; read line; echo "$line" > received; sleep 30']}));
  const host=Bun.spawn([process.execPath,'-e',script],{cwd:dir,stdout:'ignore',stderr:'ignore'});
  try{
    const {sessionSocket}=await import('../src/session/service');
    const connect=async(label:string)=>{
      const socket=createConnection(sessionSocket(dir)),decoder=new WireDecoder(),frames:{type:number;data:Buffer}[]=[];sockets.push(socket);
      socket.on('data',b=>frames.push(...decoder.push(Buffer.from(b))));
      await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
      socket.write(wire(FrameType.hello,{v:1,label}));await until(()=>frames.some(f=>f.type===FrameType.snapshot));return {socket,frames};
    };
    await until(()=>existsSync(sessionSocket(dir)));const a=await connect('before');
    await until(()=>existsSync(join(dir,'failed')));await Bun.sleep(30);
    a.socket.write(wire(FrameType.take,{}));
    await until(()=>a.frames.some(f=>f.type===FrameType.control&&JSON.parse(f.data.toString()).you));
    const taken=statSync(join(dir,'session.activity')).mtimeMs;
    await Bun.sleep(30);a.socket.write(wire(FrameType.input,Buffer.from('hello\n')));
    await until(()=>existsSync(join(dir,'received')));expect(readFileSync(join(dir,'received'),'utf8')).toBe('hello\n');
    expect(statSync(join(dir,'session.activity')).mtimeMs).toBeGreaterThan(taken);
    a.socket.write(wire(FrameType.size,{cols:91,rows:29}));
    await until(()=>JSON.parse(readFileSync(join(dir,'session.state'),'utf8')).cols===91);
    a.socket.write(wire(FrameType.release,{}));
    await until(()=>JSON.parse(readFileSync(join(dir,'session.state'),'utf8')).controller===null);
    const b=await connect('after');b.socket.write(wire(FrameType.take,{}));
    await until(()=>b.frames.some(f=>f.type===FrameType.control&&JSON.parse(f.data.toString()).you));
  }finally{for(const socket of sockets)socket.destroy();host.kill('SIGTERM');await host.exited;rmSync(dir,{recursive:true,force:true});}
},10000);
