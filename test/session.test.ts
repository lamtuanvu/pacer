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


test("attach selects a remote task's local mirror and replays it offline", async()=>{
  const home=temp(),ctx=makeCtx({pacerHome:home});
  const {attachDirectory,attachSession}=await import("../src/session/attach");
  const task=createTask(ctx,{brief:{goal:"remote",repo:"."},kind:"small",requestedExecutor:null,timeoutS:30});
  const dir=join(home,"runs",task.id,"1");mkdirSync(dir,{recursive:true});
  updateTask(ctx,task.id,t=>{t.run={host:"box",attempt:1} as NonNullable<typeof t.run>;});
  const recording=new Recording(dir);await recording.output(Buffer.from("remote mirror\n"));await recording.close();
  const original=process.stdout.write;let drawn="";
  try {
    expect(attachDirectory(ctx,task.id)).toBe(dir);
    process.stdout.write=((data: string | Uint8Array)=>{drawn+=data.toString();return true;}) as typeof original;
    await attachSession(dir);
    expect(drawn).toContain("remote mirror");
  }finally{process.stdout.write=original;rmSync(home,{recursive:true,force:true});}
});
